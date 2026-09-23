use std::future::{Future, poll_fn};
use std::pin::Pin;
use std::sync::Arc;
use std::task::Poll;

use super::super::super::*;
use super::super::support::{
    MockRunEnv, minimal_context, mock_run_config, push_job, test_profiles, wait_discover_entered,
};

async fn assert_stopped_status(env: &MockRunEnv) {
    // run_start owns the final channel transition; run() publishes the final
    // disk snapshot after its owned tasks and resources have been drained.
    assert_eq!(env.lifecycle.current_mode(), RunnerMode::Stopping);
    let persisted: serde_json::Value = serde_json::from_str(
        &tokio::fs::read_to_string(env._temp_dir.path().join("status.json"))
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(persisted["mode"], "stopped");
}

// Drive a real reactor until its currently ready branches have been consumed.
// Keeping the outer future pinned lets these tests force the historical schedule:
// a retained waiter queues, another branch wins, and inline work awaits its lock.
async fn drive_ready_reactor(reactor: Pin<&mut impl Future<Output = RunnerResult<()>>>) {
    let mut reactor = std::pin::pin!(tokio::task::unconstrained(reactor));
    poll_fn(|cx| {
        assert!(reactor.as_mut().poll(cx).is_pending());
        Poll::Ready(())
    })
    .await;
    tokio::task::yield_now().await;
}

#[tokio::test]
async fn queued_heartbeat_allows_budget_pressure_and_drain_to_progress() {
    let (mut config, env) = mock_run_config(test_profiles(), 2, 4096, 1);
    let budget = Arc::clone(&config.capacity.budget);
    let (trigger, receiver) = tokio::sync::mpsc::unbounded_channel();
    config.test_hooks.manual_routine_heartbeat_rx = Some(receiver);
    let mut reactor = Box::pin(run(config));
    tokio::select! {
        result = &mut reactor => panic!("reactor exited during startup: {result:?}"),
        () = wait_discover_entered(&env, Duration::from_secs(5)) => {}
    }

    let holder = env.idle_pool.lock().await;
    trigger.send(()).unwrap();
    drive_ready_reactor(reactor.as_mut()).await;
    let lease = ResourceBudget::try_reserve_lease(&budget, 2, 4096).unwrap();
    trigger.send(()).unwrap();
    drive_ready_reactor(reactor.as_mut()).await;
    drop(holder);

    // A concurrent finalizer must be able to acquire the pool even while the
    // reactor is waiting for admission capacity.
    tokio::select! {
        result = &mut reactor => panic!("reactor exited while running: {result:?}"),
        guard = tokio::time::timeout(Duration::from_secs(2), env.idle_pool.lock()) => {
            drop(guard.expect("pool waiter must progress after the holder releases"));
        }
    }
    assert!(env.handle.heartbeat_count() > 0);
    drop(lease);
    env.drain();
    tokio::time::timeout(Duration::from_secs(5), reactor)
        .await
        .expect("budget-pressure reactor must drain")
        .unwrap();
    assert_stopped_status(&env).await;
}

#[tokio::test]
async fn queued_heartbeat_allows_fresh_admission_to_progress() {
    let (mut config, env) = mock_run_config(test_profiles(), 2, 4096, 1);
    let (trigger, receiver) = tokio::sync::mpsc::unbounded_channel();
    config.test_hooks.manual_routine_heartbeat_rx = Some(receiver);
    let mut reactor = Box::pin(run(config));
    tokio::select! {
        result = &mut reactor => panic!("reactor exited during startup: {result:?}"),
        () = wait_discover_entered(&env, Duration::from_secs(5)) => {}
    }

    let holder = env.idle_pool.lock().await;
    trigger.send(()).unwrap();
    drive_ready_reactor(reactor.as_mut()).await;
    let run_id = RunId::new_v4();
    push_job(&env, run_id, "vm0/default", Some(minimal_context(run_id)));
    drive_ready_reactor(reactor.as_mut()).await;
    drop(holder);

    tokio::select! {
        result = &mut reactor => panic!("reactor exited before job completion: {result:?}"),
        completed = env.handle.wait_completion(run_id, Duration::from_secs(5)) => {
            assert!(completed.is_some(), "fresh admission must complete after pool contention ends");
        }
    }
    assert_eq!(env.handle.claim_candidates().len(), 1);
    env.drain();
    tokio::time::timeout(Duration::from_secs(5), reactor)
        .await
        .expect("reactor must drain after fresh admission")
        .unwrap();
}

#[tokio::test]
async fn queued_heartbeat_allows_zero_job_drain_to_progress() {
    let (mut config, env) = mock_run_config(test_profiles(), 2, 4096, 1);
    let (trigger, receiver) = tokio::sync::mpsc::unbounded_channel();
    config.test_hooks.manual_routine_heartbeat_rx = Some(receiver);
    let mut reactor = Box::pin(run(config));
    tokio::select! {
        result = &mut reactor => panic!("reactor exited during startup: {result:?}"),
        () = wait_discover_entered(&env, Duration::from_secs(5)) => {}
    }

    let holder = env.idle_pool.lock().await;
    trigger.send(()).unwrap();
    drive_ready_reactor(reactor.as_mut()).await;
    env.drain();
    drive_ready_reactor(reactor.as_mut()).await;
    drop(holder);

    tokio::time::timeout(Duration::from_secs(5), reactor)
        .await
        .expect("zero-job drain must finish after pool contention ends")
        .unwrap();
    assert_stopped_status(&env).await;
}

#[tokio::test]
async fn queued_status_retry_allows_drain_without_unpublished_state() {
    let (mut config, env) = mock_run_config(test_profiles(), 2, 4096, 1);
    let status = Arc::clone(&config.shared.status);
    let (trigger, receiver) = tokio::sync::mpsc::unbounded_channel();
    config.test_hooks.manual_routine_heartbeat_rx = Some(receiver);
    let mut reactor = Box::pin(run(config));
    tokio::select! {
        result = &mut reactor => panic!("reactor exited during startup: {result:?}"),
        () = wait_discover_entered(&env, Duration::from_secs(5)) => {}
    }

    let holder = status.hold_state_for_test().await;
    trigger.send(()).unwrap();
    drive_ready_reactor(reactor.as_mut()).await;
    env.drain();
    drive_ready_reactor(reactor.as_mut()).await;
    drop(holder);

    tokio::time::timeout(Duration::from_secs(5), reactor)
        .await
        .expect("status retry must not strand lifecycle publication")
        .unwrap();
    let persisted: serde_json::Value = serde_json::from_str(
        &tokio::fs::read_to_string(env._temp_dir.path().join("status.json"))
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(persisted["mode"], "stopped");
}

#[tokio::test]
async fn queued_status_persistence_allows_newer_drain_snapshot_to_publish() {
    let (mut config, env) = mock_run_config(test_profiles(), 2, 4096, 1);
    let started = Arc::new(tokio::sync::Notify::new());
    let release = Arc::new(tokio::sync::Semaphore::new(0));
    let path = env._temp_dir.path().join("status.json");
    let status = Arc::new(StatusTracker::new_with_atomic_write_gate(
        path.clone(),
        3, // Initial and Running snapshots precede this ordered external write.
        Arc::clone(&started),
        Arc::clone(&release),
    ));
    config.shared.status = Arc::clone(&status);
    let (trigger, receiver) = tokio::sync::mpsc::unbounded_channel();
    config.test_hooks.manual_routine_heartbeat_rx = Some(receiver);
    let mut reactor = Box::pin(run(config));
    tokio::select! {
        result = &mut reactor => panic!("reactor exited during startup: {result:?}"),
        () = wait_discover_entered(&env, Duration::from_secs(5)) => {}
    }

    let writer = tokio::spawn(async move { status.set_mode(RunnerMode::Running).await });
    tokio::time::timeout(Duration::from_secs(2), started.notified())
        .await
        .expect("external status writer must reach the persistence gate");
    trigger.send(()).unwrap();
    drive_ready_reactor(reactor.as_mut()).await;
    env.drain();
    drive_ready_reactor(reactor.as_mut()).await;
    release.add_permits(1);

    // Less than the persistence timeout: progress cannot rely on the queued
    // retry timing out and forcing the runner into error teardown.
    tokio::time::timeout(Duration::from_secs(2), reactor)
        .await
        .expect("queued persistence must progress after its predecessor completes")
        .unwrap();
    writer.await.unwrap().unwrap();
    let persisted: serde_json::Value =
        serde_json::from_str(&tokio::fs::read_to_string(path).await.unwrap()).unwrap();
    assert_eq!(persisted["mode"], "stopped");
}

#[tokio::test]
async fn heartbeat_task_panic_stops_claiming_and_runs_common_teardown() {
    let (mut config, env) = mock_run_config(test_profiles(), 2, 4096, 1);
    let (trigger, receiver) = tokio::sync::mpsc::unbounded_channel();
    config.test_hooks.manual_routine_heartbeat_rx = Some(receiver);
    let mut reactor = Box::pin(run(config));
    tokio::select! {
        result = &mut reactor => panic!("reactor exited during startup: {result:?}"),
        () = wait_discover_entered(&env, Duration::from_secs(5)) => {}
    }
    env.handle.panic_next_heartbeat();
    trigger.send(()).unwrap();
    let error = tokio::time::timeout(Duration::from_secs(5), reactor)
        .await
        .expect("heartbeat owner failure must finish teardown")
        .unwrap_err();
    assert!(error.to_string().contains("heartbeat task failed"));
    assert!(env.cancel.is_cancelled());
    assert_stopped_status(&env).await;
    assert!(env.handle.claim_candidates().is_empty());
    let heartbeats = env.handle.heartbeats.lock().unwrap();
    assert_eq!(heartbeats.last().unwrap().mode, "stopping");
}

#[tokio::test]
async fn routine_gc_progresses_while_the_reactor_waits_for_the_idle_pool() {
    let (mut config, env) = mock_run_config(test_profiles(), 2, 4096, 1);
    let entered = Arc::new(tokio::sync::Notify::new());
    let release = Arc::new(tokio::sync::Semaphore::new(0));
    let paths = RunnerPaths::new(env._temp_dir.path().join("cache-runner"));
    let capacity_path = runner_host::paths::workspace_image_cache_capacity_lock_path(
        &paths.base_dir().join("locks"),
    );
    Arc::get_mut(&mut config.exec_config)
        .unwrap()
        .workspace_cache = Some(
        WorkspaceImageCache::new(paths)
            .with_routine_gc_test_gate(Arc::clone(&entered), Arc::clone(&release)),
    );
    let (trigger, receiver) = tokio::sync::mpsc::unbounded_channel();
    config.test_hooks.manual_workspace_cache_gc_rx = Some(receiver);
    let mut reactor = Box::pin(run(config));
    tokio::select! {
        result = &mut reactor => panic!("reactor exited during startup: {result:?}"),
        () = wait_discover_entered(&env, Duration::from_secs(5)) => {}
    }
    trigger.send(()).unwrap();
    tokio::select! {
        result = &mut reactor => panic!("reactor exited before GC: {result:?}"),
        result = tokio::time::timeout(Duration::from_secs(2), entered.notified()) => {
            result.expect("routine GC must acquire the capacity lock");
        }
    }
    let pool_holder = env.idle_pool.lock().await;
    env.drain();
    drive_ready_reactor(reactor.as_mut()).await;
    release.add_permits(1);

    // Deliberately do not poll the reactor. The GC owner must complete real
    // filesystem work and retain the capacity lock through its completion marker.
    let capacity_holder = tokio::time::timeout(
        Duration::from_secs(2),
        runner_host::lock::acquire(capacity_path.clone()),
    )
    .await
    .expect("routine GC must progress independently")
    .unwrap();
    assert!(capacity_holder.metadata().unwrap().len() > 0);
    drop(capacity_holder);
    drop(pool_holder);
    tokio::time::timeout(Duration::from_secs(5), reactor)
        .await
        .unwrap()
        .unwrap();
    assert_stopped_status(&env).await;
}

#[tokio::test]
async fn teardown_joins_routine_gc_before_releasing_its_capacity_lock() {
    let (mut config, env) = mock_run_config(test_profiles(), 2, 4096, 1);
    let entered = Arc::new(tokio::sync::Notify::new());
    let release = Arc::new(tokio::sync::Semaphore::new(0));
    let paths = RunnerPaths::new(env._temp_dir.path().join("cache-runner"));
    let capacity_path = runner_host::paths::workspace_image_cache_capacity_lock_path(
        &paths.base_dir().join("locks"),
    );
    Arc::get_mut(&mut config.exec_config)
        .unwrap()
        .workspace_cache = Some(
        WorkspaceImageCache::new(paths)
            .with_routine_gc_test_gate(Arc::clone(&entered), Arc::clone(&release)),
    );
    let (trigger, receiver) = tokio::sync::mpsc::unbounded_channel();
    config.test_hooks.manual_workspace_cache_gc_rx = Some(receiver);
    let mut reactor = Box::pin(run(config));
    tokio::select! {
        result = &mut reactor => panic!("reactor exited during startup: {result:?}"),
        () = wait_discover_entered(&env, Duration::from_secs(5)) => {}
    }
    trigger.send(()).unwrap();
    tokio::select! {
        result = &mut reactor => panic!("reactor exited before GC: {result:?}"),
        result = tokio::time::timeout(Duration::from_secs(2), entered.notified()) => {
            result.expect("routine GC must reach the lock-held gate");
        }
    }
    // Repeated ticks cannot start a second GC while this owner is held.
    trigger.send(()).unwrap();
    trigger.send(()).unwrap();
    drive_ready_reactor(reactor.as_mut()).await;
    env.trigger_stopping().await;
    tokio::select! {
        result = &mut reactor => panic!("teardown abandoned unfinished GC: {result:?}"),
        () = env.start_observer.wait_for(
            Duration::from_secs(2),
            "maintenance drain",
            |event| matches!(event, StartLoopEvent::MaintenanceDrainEntered).then_some(()),
        ) => {}
    }
    drive_ready_reactor(reactor.as_mut()).await;
    assert!(matches!(
        runner_host::lock::try_acquire_or_busy(capacity_path.clone())
            .await
            .unwrap(),
        runner_host::lock::TryLock::Busy
    ));
    release.add_permits(1);
    tokio::time::timeout(Duration::from_secs(5), reactor)
        .await
        .expect("GC completion must unblock teardown")
        .unwrap();
    let capacity_holder = runner_host::lock::acquire(capacity_path).await.unwrap();
    assert!(capacity_holder.metadata().unwrap().len() > 0);
    assert_stopped_status(&env).await;
}
