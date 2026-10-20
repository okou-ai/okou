use super::super::super::*;
use super::super::support::{
    mock_run_config, seed_home_cache_state, shutdown, test_profiles, wait_discover_entered,
    wait_status_mode,
};

async fn status_mode(path: &std::path::Path) -> String {
    let bytes = tokio::fs::read(path).await.unwrap();
    serde_json::from_slice::<serde_json::Value>(&bytes).unwrap()["mode"]
        .as_str()
        .unwrap()
        .to_owned()
}

#[tokio::test]
async fn initial_inventory_overlaps_provider_startup_and_acknowledgment_precedes_running() {
    for nonempty in [false, true] {
        let mut profiles = test_profiles();
        profiles.get_mut("vm0/default").unwrap().home_disk_mb = 16;
        let (mut config, env) = mock_run_config(profiles, 8, 32768, 4);
        let paths = RunnerPaths::new(config.paths.base_dir.clone());
        let cache = HomeImageCache::shared(paths.clone(), &config.paths.home, &config.runner.group);
        if nonempty {
            seed_home_cache_state(
                &cache,
                &paths,
                "thread:initial-ready",
                "vm0/default",
                16 * 1024 * 1024,
            )
            .await;
        }
        Arc::get_mut(&mut config.exec_config).unwrap().home_cache = Some(cache);
        let gate = StartLoopTestGate::default();
        config.test_hooks.before_initial_home_cache_scan = Some(gate.clone());
        env.handle.block_startup_readiness();
        env.handle.block_heartbeats();
        let status = env._temp_dir.path().join("status.json");
        let run_handle = tokio::spawn(run(config));

        assert!(
            env.handle
                .wait_startup_readiness_entered(Duration::from_secs(5))
                .await
        );
        gate.wait_entered(
            Duration::from_secs(5),
            "scan must overlap blocked provider startup",
        )
        .await;
        env.handle.release_startup_readiness();
        assert_eq!(status_mode(&status).await, "starting");
        assert_eq!(env.handle.discover_started_count(), 0);
        assert_eq!(env.handle.heartbeat_count(), 0);
        gate.release();
        assert!(
            env.handle
                .wait_heartbeat_in_flight(1, Duration::from_secs(5))
                .await
        );
        assert_eq!(status_mode(&status).await, "starting");
        assert_eq!(env.handle.discover_started_count(), 0);
        {
            let heartbeats = env.handle.heartbeats.lock().unwrap();
            assert_eq!(heartbeats.len(), 1);
            assert_eq!(heartbeats[0].snapshot_generation, 7);
            assert_eq!(heartbeats[0].snapshot_sequence, 1);
            assert_eq!(heartbeats[0].mode, "running");
            assert_eq!(heartbeats[0].held_home_states.len(), usize::from(nonempty));
            if nonempty {
                assert_eq!(
                    heartbeats[0].held_home_states[0].reuse_key,
                    "thread:initial-ready"
                );
            }
        }
        env.handle.unblock_heartbeats();
        wait_status_mode(&status, "running", Duration::from_secs(5)).await;
        wait_discover_entered(&env, Duration::from_secs(5)).await;
        shutdown(&env, run_handle).await;
    }
}

#[tokio::test]
async fn failed_initial_heartbeat_rolls_back_without_running_or_discovery() {
    let (config, env) = mock_run_config(test_profiles(), 8, 32768, 4);
    env.handle.fail_next_heartbeat();
    let status = env._temp_dir.path().join("status.json");
    let error = tokio::time::timeout(Duration::from_secs(5), run(config))
        .await
        .unwrap()
        .unwrap_err();
    assert!(
        error
            .to_string()
            .contains("initial home-cache heartbeat failed")
    );
    assert!(
        !error
            .to_string()
            .contains("private heartbeat response body")
    );
    assert_eq!(status_mode(&status).await, "stopped");
    assert_eq!(env.handle.discover_started_count(), 0);
    {
        let heartbeats = env.handle.heartbeats.lock().unwrap();
        assert_eq!(heartbeats.len(), 2);
        assert_eq!(heartbeats[1].mode, "stopping");
        assert_eq!(heartbeats[1].snapshot_sequence, 2);
    }
    env.shutdown_startup_api().await;
}

#[tokio::test]
async fn incomplete_initial_scan_cannot_report_false_empty_readiness() {
    let (mut config, env) = mock_run_config(test_profiles(), 8, 32768, 4);
    let cache = HomeImageCache::shared(
        RunnerPaths::new(config.paths.base_dir.clone()),
        &config.paths.home,
        &config.runner.group,
    );
    tokio::fs::write(config.paths.home.home_image_cache_dir(), b"not a directory")
        .await
        .unwrap();
    Arc::get_mut(&mut config.exec_config).unwrap().home_cache = Some(cache);
    let status = env._temp_dir.path().join("status.json");
    let error = tokio::time::timeout(Duration::from_secs(5), run(config))
        .await
        .unwrap()
        .unwrap_err();
    assert!(
        error
            .to_string()
            .contains("initial home-cache inventory scan incomplete")
    );
    assert_eq!(status_mode(&status).await, "stopped");
    assert_eq!(env.handle.discover_started_count(), 0);
    assert_eq!(env.handle.heartbeat_count(), 0);
    env.shutdown_startup_api().await;
}

#[tokio::test]
async fn cancellation_joins_blocked_initial_scan_without_publishing_running() {
    let (mut config, env) = mock_run_config(test_profiles(), 8, 32768, 4);
    let gate = StartLoopTestGate::default();
    config.test_hooks.before_initial_home_cache_scan = Some(gate.clone());
    let status = env._temp_dir.path().join("status.json");
    let run_handle = tokio::spawn(run(config));
    gate.wait_entered(Duration::from_secs(5), "blocked initial scan")
        .await;
    assert_eq!(status_mode(&status).await, "starting");
    env.cancel.cancel();
    tokio::time::timeout(Duration::from_secs(5), run_handle)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert_eq!(status_mode(&status).await, "stopped");
    assert_eq!(env.handle.discover_started_count(), 0);
    assert_eq!(env.handle.heartbeat_count(), 0);
    env.shutdown_startup_api().await;
}

#[tokio::test]
async fn cancelled_initial_delivery_is_drained_then_fenced_before_startup_exit() {
    let (config, env) = mock_run_config(test_profiles(), 8, 32768, 4);
    env.handle.block_heartbeats();
    let status = env._temp_dir.path().join("status.json");
    let run_handle = tokio::spawn(run(config));
    assert!(
        env.handle
            .wait_heartbeat_in_flight(1, Duration::from_secs(5))
            .await
    );
    env.cancel.cancel();
    assert_eq!(status_mode(&status).await, "starting");
    assert!(!run_handle.is_finished());
    env.handle.unblock_heartbeats();
    tokio::time::timeout(Duration::from_secs(5), run_handle)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert_eq!(status_mode(&status).await, "stopped");
    assert_eq!(env.handle.discover_started_count(), 0);
    {
        let heartbeats = env.handle.heartbeats.lock().unwrap();
        assert_eq!(heartbeats.len(), 2);
        assert_eq!(heartbeats[1].mode, "stopping");
        assert_eq!(heartbeats[1].snapshot_sequence, 2);
    }
    env.shutdown_startup_api().await;
}

#[tokio::test]
async fn initial_delivery_deadline_fails_startup_and_fences_its_late_response() {
    let (config, env) = mock_run_config(test_profiles(), 8, 32768, 4);
    env.handle.block_heartbeats();
    let status = env._temp_dir.path().join("status.json");
    let mut reactor = Box::pin(run(config));
    tokio::select! {
        result = &mut reactor => panic!("startup exited before its delivery gate: {result:?}"),
        entered = env.handle.wait_heartbeat_in_flight(1, Duration::from_secs(5)) => assert!(entered),
    }
    // Arm the real timeout before pausing, after filesystem/socket setup has
    // completed. Keep delivery blocked while positively polling its deadline.
    tokio::time::pause();
    tokio::time::advance(Duration::from_secs(59)).await;
    assert!(futures_util::poll!(&mut reactor).is_pending());
    tokio::time::advance(Duration::from_secs(2)).await;
    tokio::task::yield_now().await;
    assert!(futures_util::poll!(&mut reactor).is_pending());
    tokio::time::resume();
    env.handle.unblock_heartbeats();
    let error = tokio::time::timeout(Duration::from_secs(5), reactor)
        .await
        .unwrap()
        .unwrap_err();
    assert!(
        error
            .to_string()
            .contains("initial home-cache readiness timed out after 60s")
    );
    assert_eq!(status_mode(&status).await, "stopped");
    assert_eq!(env.handle.discover_started_count(), 0);
    {
        let heartbeats = env.handle.heartbeats.lock().unwrap();
        assert_eq!(heartbeats.last().unwrap().mode, "stopping");
        assert_eq!(heartbeats.last().unwrap().snapshot_sequence, 2);
    }
    env.shutdown_startup_api().await;
}
