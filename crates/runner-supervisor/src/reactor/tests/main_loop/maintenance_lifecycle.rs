use std::path::Path;
use std::sync::Arc;

use super::super::super::*;
use super::super::support::{
    assert_run_exits_within, minimal_context, mock_run_config_with_overrides, push_job,
    seed_home_cache_state, test_profiles, wait_status_mode,
};
use crate::home_image_cache::{FsStats, HomeImagePrepareLockTestGate};

async fn wait_for_removal(path: &Path) {
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            match tokio::fs::symlink_metadata(path).await {
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => break,
                Err(error) => panic!("observe cache removal: {error}"),
                Ok(_) => tokio::task::yield_now().await,
            }
        }
    })
    .await
    .expect("background maintenance must remove the selected cache entry");
}

async fn background_gc_lifecycle(pressure: bool, resume: bool) {
    let job_gate = sandbox_mock::MockLifecycleGate::new();
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    overrides.set_wait_process_lifecycle_gate(job_gate.clone());
    let mut profiles = test_profiles();
    profiles.get_mut("vm0/default").unwrap().home_disk_mb = 1;
    let (mut config, env) = mock_run_config_with_overrides(profiles, 8, 32768, 4, overrides);
    let paths = RunnerPaths::new(config.paths.base_dir.clone());
    let cache = HomeImageCache::shared(paths.clone(), &config.paths.home, &config.runner.group);
    seed_home_cache_state(&cache, &paths, "unused-home", "vm0/default", 1024 * 1024).await;
    let key = runner_host::paths::scoped_home_image_cache_key(
        &config.runner.group,
        "vm0/default",
        "unused-home",
        1024 * 1024,
    );
    let entry = cache.entry_paths(&key).entry_dir().to_owned();
    let marker =
        runner_host::paths::home_image_cache_routine_gc_lock_path(&config.paths.home.locks_dir());
    cache.set_fs_stats_for_test(FsStats {
        total_bytes: 100 * 1024 * 1024 * 1024,
        available_bytes: 55 * 1024 * 1024 * 1024,
        ..FsStats::default()
    });
    let routine_entered = Arc::new(tokio::sync::Notify::new());
    let routine_release = Arc::new(tokio::sync::Semaphore::new(0));
    let pressure_gate = HomeImagePrepareLockTestGate::default();
    let controlled_cache = if pressure {
        cache
            .clone()
            .with_pressure_turn_test_gate(pressure_gate.clone())
    } else {
        cache
            .clone()
            .with_routine_gc_test_gate(routine_entered.clone(), routine_release.clone())
    };
    Arc::get_mut(&mut config.exec_config).unwrap().home_cache = Some(controlled_cache);
    let (routine_tick, routine_rx) = tokio::sync::mpsc::unbounded_channel();
    let (pressure_tick, pressure_rx) = tokio::sync::mpsc::unbounded_channel();
    config.test_hooks.manual_home_cache_gc_rx = Some(routine_rx);
    config.test_hooks.manual_home_cache_pressure_rx = Some(pressure_rx);
    let run_handle = tokio::spawn(run(config));
    let run_id = RunId::new_v4();
    push_job(&env, run_id, "vm0/default", Some(minimal_context(run_id)));
    job_gate
        .wait_entered(1, Duration::from_secs(5))
        .await
        .unwrap();
    let status = env._temp_dir.path().join("status.json");
    env.drain();
    wait_status_mode(&status, "draining", Duration::from_secs(5)).await;
    let trigger = if pressure {
        &pressure_tick
    } else {
        &routine_tick
    };
    trigger.send(()).unwrap();
    env.start_observer
        .wait_for(
            Duration::from_secs(5),
            "draining maintenance tick",
            |event| {
                (if pressure {
                    matches!(event, StartLoopEvent::HomeCachePressureTickConsumed)
                } else {
                    matches!(event, StartLoopEvent::HomeCacheGcTickConsumed)
                })
                .then_some(())
            },
        )
        .await;
    if resume {
        env.resume();
        wait_status_mode(&status, "running", Duration::from_secs(5)).await;
        trigger.send(()).unwrap();
        if pressure {
            pressure_gate.wait_entered(Duration::from_secs(5)).await;
            assert!(entry.exists());
            pressure_gate.release();
        } else {
            tokio::time::timeout(Duration::from_secs(5), routine_entered.notified())
                .await
                .unwrap();
            assert!(entry.exists());
            routine_release.add_permits(1);
        }
        wait_for_removal(&entry).await;
    }
    env.drain();
    job_gate.release_one();
    let completion = env
        .handle
        .wait_completion(run_id, Duration::from_secs(5))
        .await
        .expect("drain must preserve the accepted job");
    assert_eq!(completion.exit_code, 0);
    assert!(completion.error.is_none());
    assert_run_exits_within(
        run_handle,
        Duration::from_secs(5),
        "accepted work must drain",
    )
    .await;
    assert_eq!(entry.exists(), !resume);
    if !resume {
        assert!(!marker.exists(), "draining must not start a collector");
    } else if pressure {
        assert_eq!(std::fs::metadata(marker).unwrap().len(), 0);
    }
}

#[tokio::test]
async fn draining_runner_does_not_start_periodic_maintenance_gc() {
    background_gc_lifecycle(false, false).await;
}

#[tokio::test]
async fn draining_runner_does_not_start_periodic_pressure_gc() {
    background_gc_lifecycle(true, false).await;
}

#[tokio::test]
async fn resumed_runner_accepts_fresh_periodic_maintenance_gc() {
    background_gc_lifecycle(false, true).await;
}

#[tokio::test]
async fn resumed_runner_accepts_fresh_periodic_pressure_gc() {
    background_gc_lifecycle(true, true).await;
}
