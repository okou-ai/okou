use std::future::{Future, poll_fn};
use std::sync::Arc;
use std::task::Poll;

use super::*;
use tokio::sync::{Notify, Semaphore};

fn read_status(path: &std::path::Path) -> serde_json::Value {
    let content = std::fs::read_to_string(path).unwrap();
    serde_json::from_str(&content).unwrap()
}

async fn assert_latest_generation_published(tracker: &StatusTracker) {
    let requested_generation = tracker.state.lock().await.generation;
    assert_eq!(
        tracker
            .persistence
            .published_generation
            .load(Ordering::Acquire),
        requested_generation,
    );
}

#[tokio::test]
async fn idle_snapshot_wait_observer_requires_a_polled_held_lock() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("status.json");
    let tracker = StatusTracker::new(path.clone(), 1, None, None);
    tracker.write_initial().await.unwrap();
    let mut waits = tracker.idle_snapshot_waits_for_test();
    tracker
        .set_idle_snapshot(IdlePoolSnapshot::default())
        .await
        .unwrap();
    assert_eq!(*waits.borrow_and_update(), 0);
    let before = std::fs::read(&path).unwrap();
    let holder = tracker.hold_state_for_test().await;
    let write = tracker.set_idle_snapshot(IdlePoolSnapshot {
        revision: 1,
        ..IdlePoolSnapshot::default()
    });
    tokio::pin!(write);
    assert!(futures_util::poll!(&mut write).is_pending());
    waits.changed().await.unwrap();
    assert_eq!(*waits.borrow_and_update(), 1);
    assert_eq!(std::fs::read(&path).unwrap(), before);
    drop(holder);
    assert!(write.await.unwrap());
    assert_eq!(*waits.borrow_and_update(), 1);
    assert_latest_generation_published(&tracker).await;
}

#[tokio::test]
async fn write_initial_creates_file() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("status.json");
    let tracker = StatusTracker::new(path.clone(), 4, None, None);

    tracker.write_initial().await.unwrap();

    let status = read_status(&path);
    assert_eq!(status["mode"], "starting");
    assert_eq!(status["max_concurrent"], 4);
    assert!(status["active_runs"].as_array().unwrap().is_empty());
    assert!(status["started_at"].as_str().is_some());
    assert!(status["updated_at"].as_str().is_some());
    assert_latest_generation_published(&tracker).await;
}

#[tokio::test]
async fn blocked_status_write_releases_state_for_new_snapshot() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("status.json");
    let started = Arc::new(Notify::new());
    let release = Arc::new(Semaphore::new(0));
    let tracker = Arc::new(StatusTracker::new_with_write_gate(
        path.clone(),
        1,
        Arc::clone(&started),
        Arc::clone(&release),
    ));
    let run_id = RunId::new_v4();
    let sandbox_id = SandboxId::new_v4();

    let first_write_started = started.notified();
    let first_tracker = Arc::clone(&tracker);
    let first = tokio::spawn(async move {
        first_tracker
            .add_preparing_run(run_id, sandbox_id)
            .await
            .unwrap();
    });
    first_write_started.await;

    let mut second = Box::pin(tracker.set_mode(RunnerMode::Draining));
    let second_is_pending =
        poll_fn(|cx| Poll::Ready(matches!(second.as_mut().poll(cx), Poll::Pending))).await;
    assert!(
        second_is_pending,
        "second transition should wait for ordered persistence"
    );

    {
        let state = tracker
            .state
            .try_lock()
            .expect("state lock should be released before persistence");
        assert_eq!(state.generation, 2);
        assert_eq!(state.mode, RunnerMode::Draining);
        let active = state.active_runs.get(&run_id).unwrap();
        assert_eq!(active.sandbox_id, sandbox_id);
        assert_eq!(active.phase, ActiveRunPhase::Preparing);
    }

    release.add_permits(1);
    second.await.unwrap();
    first.await.unwrap();

    let status = read_status(&path);
    assert_eq!(status["mode"], "draining");
    let runs = status["active_runs"].as_array().unwrap();
    assert_eq!(runs.len(), 1);
    assert_eq!(runs[0]["run_id"], run_id.to_string());
    assert_eq!(runs[0]["sandbox_id"], sandbox_id.to_string());
    assert_eq!(runs[0]["phase"], "preparing");
}

#[tokio::test(start_paused = true)]
async fn pre_write_timeout_releases_persistence_ordering() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("status.json");
    let started = Arc::new(Notify::new());
    let tracker = Arc::new(StatusTracker::new_with_write_gate(
        path.clone(),
        1,
        Arc::clone(&started),
        Arc::new(Semaphore::new(0)),
    ));

    let write_started = started.notified();
    let write_tracker = Arc::clone(&tracker);
    let write = tokio::spawn(async move { write_tracker.write_initial().await });
    write_started.await;
    tokio::time::advance(STATUS_PERSISTENCE_TIMEOUT).await;

    let error = write.await.unwrap().unwrap_err();
    assert!(matches!(error, StatusPersistenceError::Timeout { .. }));
    assert!(
        tracker.persistence.ordering.try_lock().is_ok(),
        "a timeout before atomic I/O starts must release persistence ordering"
    );

    tracker.set_mode(RunnerMode::Running).await.unwrap();
    let status = read_status(&path);
    assert_eq!(status["mode"], "running");
    assert_latest_generation_published(&tracker).await;
}

#[tokio::test]
async fn pre_write_task_abort_allows_newer_generation_to_publish() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("status.json");
    let started = Arc::new(Notify::new());
    let tracker = Arc::new(StatusTracker::new_with_write_gate(
        path.clone(),
        1,
        Arc::clone(&started),
        Arc::new(Semaphore::new(0)),
    ));

    let write_started = started.notified();
    let write_tracker = Arc::clone(&tracker);
    let write = tokio::spawn(async move { write_tracker.write_initial().await });
    write_started.await;
    write.abort();
    assert!(write.await.unwrap_err().is_cancelled());
    assert!(!path.exists());

    // The cancelled generation's gate stays closed while the newer one publishes.
    tracker.set_mode(RunnerMode::Running).await.unwrap();
    let status = read_status(&path);
    assert_eq!(status["mode"], "running");
}

#[tokio::test(start_paused = true)]
async fn atomic_write_timeout_keeps_ordering_and_coalesces_newer_generation() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("status.json");
    let started = Arc::new(Notify::new());
    let release = Arc::new(Semaphore::new(0));
    let tracker = Arc::new(StatusTracker::new_with_atomic_write_gate(
        path.clone(),
        1,
        Arc::clone(&started),
        Arc::clone(&release),
    ));

    let write_started = started.notified();
    let write_tracker = Arc::clone(&tracker);
    let write = tokio::spawn(async move { write_tracker.write_initial().await });
    write_started.await;
    tokio::time::advance(STATUS_PERSISTENCE_TIMEOUT).await;

    let error = write.await.unwrap().unwrap_err();
    assert!(matches!(error, StatusPersistenceError::Timeout { .. }));
    assert!(
        tracker.persistence.ordering.try_lock().is_err(),
        "the timed-out write must keep ordering ownership until it finishes"
    );

    let error = tracker.set_mode(RunnerMode::Running).await.unwrap_err();
    assert!(matches!(error, StatusPersistenceError::Timeout { .. }));
    let settled = tracker.persistence.settled.notified();
    release.add_permits(1);
    settled.await;
    assert!(
        !tracker
            .persistence
            .delayed
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .active,
        "the timed-out writer should publish the coalesced snapshot"
    );
    let status = read_status(&path);
    assert_eq!(status["mode"], "running");
    assert_latest_generation_published(&tracker).await;
}

#[tokio::test]
async fn atomic_write_task_abort_keeps_ordering_and_coalesces_newer_generation() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("status.json");
    let started = Arc::new(Notify::new());
    let release = Arc::new(Semaphore::new(0));
    let tracker = Arc::new(StatusTracker::new_with_atomic_write_gate(
        path.clone(),
        1,
        Arc::clone(&started),
        Arc::clone(&release),
    ));

    let write_started = started.notified();
    let write_tracker = Arc::clone(&tracker);
    let write = tokio::spawn(async move { write_tracker.write_initial().await });
    write_started.await;
    write.abort();
    assert!(write.await.unwrap_err().is_cancelled());
    assert!(
        tracker.persistence.ordering.try_lock().is_err(),
        "an aborted caller must not release ordering for a started write"
    );

    let error = tracker.set_mode(RunnerMode::Running).await.unwrap_err();
    assert!(matches!(error, StatusPersistenceError::Timeout { .. }));
    let settled = tracker.persistence.settled.notified();
    release.add_permits(1);
    settled.await;
    assert!(
        !tracker
            .persistence
            .delayed
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .active,
        "the continued writer should publish the coalesced snapshot"
    );
    let status = read_status(&path);
    assert_eq!(status["mode"], "running");
}

#[tokio::test]
async fn failed_status_write_is_reported_and_newer_generation_can_publish() {
    let dir = tempfile::tempdir().unwrap();
    let parent = dir.path().join("missing");
    let path = parent.join("status.json");
    let tracker = StatusTracker::new(path.clone(), 4, None, None);

    let error = tracker.write_initial().await.unwrap_err();
    assert!(matches!(error, StatusPersistenceError::Write { .. }));

    tokio::fs::create_dir(&parent).await.unwrap();
    tracker.set_mode(RunnerMode::Running).await.unwrap();
    let status = read_status(&path);
    assert_eq!(status["mode"], "running");
    assert_latest_generation_published(&tracker).await;
}

#[tokio::test]
async fn remove_run_if_matching_retries_failed_publication_without_another_mutation() {
    let dir = tempfile::tempdir().unwrap();
    let parent = dir.path().join("status");
    let unavailable_parent = dir.path().join("status-unavailable");
    tokio::fs::create_dir(&parent).await.unwrap();
    let path = parent.join("status.json");
    let tracker = StatusTracker::new(path.clone(), 4, None, None);
    let run_id = RunId::new_v4();
    let sandbox_id = SandboxId::new_v4();
    tracker.add_run(run_id, sandbox_id).await.unwrap();

    tokio::fs::rename(&parent, &unavailable_parent)
        .await
        .unwrap();
    let error = tracker
        .remove_run_if_matching(run_id, sandbox_id)
        .await
        .unwrap_err();
    assert!(matches!(error, StatusPersistenceError::Write { .. }));
    tokio::fs::rename(&unavailable_parent, &parent)
        .await
        .unwrap();

    assert!(
        !tracker
            .remove_run_if_matching(run_id, sandbox_id)
            .await
            .unwrap()
    );

    let status = read_status(&path);
    assert!(status["active_runs"].as_array().unwrap().is_empty());
    assert_latest_generation_published(&tracker).await;
}

#[tokio::test]
async fn failed_removal_retry_publishes_replacement_sandbox() {
    let dir = tempfile::tempdir().unwrap();
    let parent = dir.path().join("status");
    let unavailable_parent = dir.path().join("status-unavailable");
    tokio::fs::create_dir(&parent).await.unwrap();
    let path = parent.join("status.json");
    let tracker = StatusTracker::new(path.clone(), 4, None, None);
    let run_id = RunId::new_v4();
    let old_sandbox_id = SandboxId::new_v4();
    let current_sandbox_id = SandboxId::new_v4();
    tracker.add_run(run_id, old_sandbox_id).await.unwrap();

    tokio::fs::rename(&parent, &unavailable_parent)
        .await
        .unwrap();
    let removal_error = tracker
        .remove_run_if_matching(run_id, old_sandbox_id)
        .await
        .unwrap_err();
    assert!(matches!(
        removal_error,
        StatusPersistenceError::Write { .. }
    ));
    let replacement_error = tracker
        .add_run(run_id, current_sandbox_id)
        .await
        .unwrap_err();
    assert!(matches!(
        replacement_error,
        StatusPersistenceError::Write { .. }
    ));
    tokio::fs::rename(&unavailable_parent, &parent)
        .await
        .unwrap();

    assert!(
        !tracker
            .remove_run_if_matching(run_id, old_sandbox_id)
            .await
            .unwrap()
    );

    let status = read_status(&path);
    let runs = status["active_runs"].as_array().unwrap();
    assert_eq!(runs.len(), 1);
    assert_eq!(runs[0]["run_id"], run_id.to_string());
    assert_eq!(runs[0]["sandbox_id"], current_sandbox_id.to_string());
    assert_latest_generation_published(&tracker).await;
}

#[tokio::test]
async fn older_snapshot_does_not_replace_newer_publication() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("status.json");
    let tracker = StatusTracker::new(path.clone(), 4, None, None);

    let (older, newer) = {
        let mut state = tracker.state.lock().await;
        state.mode = RunnerMode::Running;
        let older = tracker.capture_changed_snapshot(&mut state);
        state.mode = RunnerMode::Draining;
        let newer = tracker.capture_changed_snapshot(&mut state);
        (older, newer)
    };

    tracker.persist_snapshot(newer).await.unwrap();
    tracker.persist_snapshot(older).await.unwrap();

    let status = read_status(&path);
    assert_eq!(status["mode"], "draining");
}

#[cfg(unix)]
#[tokio::test]
async fn write_initial_does_not_follow_stale_status_temp_symlink() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("status.json");
    let stale_target = dir.path().join("outside-status-target");
    let stale_tmp = dir.path().join("status.tmp");
    std::fs::write(&stale_target, b"do not overwrite").unwrap();
    std::os::unix::fs::symlink(&stale_target, &stale_tmp).unwrap();
    let tracker = StatusTracker::new(path.clone(), 4, None, None);

    tracker.write_initial().await.unwrap();

    assert_eq!(std::fs::read(&stale_target).unwrap(), b"do not overwrite");
    assert!(
        std::fs::symlink_metadata(&stale_tmp)
            .unwrap()
            .file_type()
            .is_symlink()
    );
    let status = read_status(&path);
    assert_eq!(status["mode"], "starting");
}

#[tokio::test]
async fn remove_stale_status_file_ignores_missing_file() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("status.json");

    remove_stale_status_file(&path).await.unwrap();

    assert!(!path.exists());
}

#[tokio::test]
async fn remove_stale_status_file_removes_existing_file() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("status.json");
    std::fs::write(&path, r#"{"mode":"running"}"#).unwrap();

    remove_stale_status_file(&path).await.unwrap();

    assert!(!path.exists());
}

#[cfg(unix)]
#[tokio::test]
async fn remove_stale_status_file_removes_symlink_without_touching_target() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("status.json");
    let target = dir.path().join("target-status");
    std::fs::write(&target, b"keep me").unwrap();
    std::os::unix::fs::symlink(&target, &path).unwrap();

    remove_stale_status_file(&path).await.unwrap();

    assert!(!path.exists());
    assert_eq!(std::fs::read(&target).unwrap(), b"keep me");
}

#[tokio::test]
async fn set_mode_updates_file() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("status.json");
    let tracker = StatusTracker::new(path.clone(), 4, None, None);

    tracker.write_initial().await.unwrap();
    tracker.set_mode(RunnerMode::Draining).await.unwrap();

    let status = read_status(&path);
    assert_eq!(status["mode"], "draining");
}

#[tokio::test]
async fn add_run_records_sandbox_id() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("status.json");
    let tracker = StatusTracker::new(path.clone(), 4, None, None);

    let run_id = RunId::new_v4();
    let sandbox_id = SandboxId::new_v4();

    tracker.write_initial().await.unwrap();
    tracker.add_run(run_id, sandbox_id).await.unwrap();

    let status = read_status(&path);
    let runs = status["active_runs"].as_array().unwrap();
    assert_eq!(runs.len(), 1);
    assert_eq!(runs[0]["run_id"], run_id.to_string());
    assert_eq!(runs[0]["sandbox_id"], sandbox_id.to_string());
    assert_eq!(runs[0]["phase"], "running");
    assert!(runs[0]["phase_started_at"].as_str().is_some());
}

#[tokio::test]
async fn add_preparing_run_records_phase_and_timestamp() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("status.json");
    let tracker = StatusTracker::new(path.clone(), 4, None, None);

    let run_id = RunId::new_v4();
    let sandbox_id = SandboxId::new_v4();

    tracker.write_initial().await.unwrap();
    tracker.add_preparing_run(run_id, sandbox_id).await.unwrap();

    let status = read_status(&path);
    let runs = status["active_runs"].as_array().unwrap();
    assert_eq!(runs.len(), 1);
    assert_eq!(runs[0]["run_id"], run_id.to_string());
    assert_eq!(runs[0]["sandbox_id"], sandbox_id.to_string());
    assert_eq!(runs[0]["phase"], "preparing");
    let phase_started_at = runs[0]["phase_started_at"].as_str().unwrap();
    assert!(chrono::DateTime::parse_from_rfc3339(phase_started_at).is_ok());
}

#[tokio::test]
async fn resource_replacement_updates_only_the_current_owner_and_stale_cleanup_cannot_remove_it() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("status.json");
    let tracker = StatusTracker::new(path.clone(), 4, None, None);
    let run_id = RunId::new_v4();
    let original = SandboxId::new_v4();
    let replacement = SandboxId::new_v4();
    tracker.add_run(run_id, original).await.unwrap();
    let snapshot =
        crate::idle_pool::IdlePool::new(crate::idle_pool::IdlePoolConfig { max_idle: 0 })
            .status_snapshot();
    assert!(
        !tracker
            .replace_run_sandbox_if_matching(run_id, replacement, original, snapshot.clone())
            .await
            .unwrap()
    );
    assert_eq!(
        read_status(&path)["active_runs"][0]["sandbox_id"],
        original.to_string()
    );
    assert!(
        tracker
            .replace_run_sandbox_if_matching(run_id, original, replacement, snapshot)
            .await
            .unwrap()
    );
    let status = read_status(&path);
    assert_eq!(
        status["active_runs"][0]["sandbox_id"],
        replacement.to_string()
    );
    assert_eq!(status["active_runs"][0]["phase"], "preparing");
    assert!(
        !tracker
            .remove_run_if_matching(run_id, original)
            .await
            .unwrap()
    );
    assert!(
        tracker
            .mark_run_running_if_matching(run_id, replacement)
            .await
            .unwrap()
    );
    assert!(
        tracker
            .remove_run_if_matching(run_id, replacement)
            .await
            .unwrap()
    );
    assert!(
        read_status(&path)["active_runs"]
            .as_array()
            .unwrap()
            .is_empty()
    );
}

#[tokio::test]
async fn mark_run_running_if_matching_updates_only_matching_sandbox() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("status.json");
    let tracker = StatusTracker::new(path.clone(), 4, None, None);

    let run_id = RunId::new_v4();
    let stale_sandbox_id = SandboxId::new_v4();
    let current_sandbox_id = SandboxId::new_v4();

    tracker.write_initial().await.unwrap();
    tracker
        .add_preparing_run(run_id, stale_sandbox_id)
        .await
        .unwrap();
    tracker
        .add_preparing_run(run_id, current_sandbox_id)
        .await
        .unwrap();

    assert!(
        !tracker
            .mark_run_running_if_matching(run_id, stale_sandbox_id)
            .await
            .unwrap()
    );
    let status = read_status(&path);
    let runs = status["active_runs"].as_array().unwrap();
    assert_eq!(runs.len(), 1);
    assert_eq!(runs[0]["sandbox_id"], current_sandbox_id.to_string());
    assert_eq!(runs[0]["phase"], "preparing");

    assert!(
        tracker
            .mark_run_running_if_matching(run_id, current_sandbox_id)
            .await
            .unwrap()
    );
    let status = read_status(&path);
    let runs = status["active_runs"].as_array().unwrap();
    assert_eq!(runs.len(), 1);
    assert_eq!(runs[0]["sandbox_id"], current_sandbox_id.to_string());
    assert_eq!(runs[0]["phase"], "running");
}

#[tokio::test]
async fn add_and_remove_run() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("status.json");
    let tracker = StatusTracker::new(path.clone(), 4, None, None);

    let run1 = RunId::new_v4();
    let sb1 = SandboxId::new_v4();
    let run2 = RunId::new_v4();
    let sb2 = SandboxId::new_v4();

    tracker.write_initial().await.unwrap();
    tracker.add_run(run1, sb1).await.unwrap();
    tracker.add_run(run2, sb2).await.unwrap();

    let status = read_status(&path);
    assert_eq!(status["active_runs"].as_array().unwrap().len(), 2);

    assert!(tracker.remove_run_if_matching(run1, sb1).await.unwrap());

    let status = read_status(&path);
    let runs = status["active_runs"].as_array().unwrap();
    assert_eq!(runs.len(), 1);
    assert_eq!(runs[0]["run_id"], run2.to_string());
    assert_eq!(runs[0]["sandbox_id"], sb2.to_string());
}

#[tokio::test]
async fn remove_run_if_matching_preserves_replaced_sandbox() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("status.json");
    let tracker = StatusTracker::new(path.clone(), 4, None, None);

    let run_id = RunId::new_v4();
    let old_sandbox_id = SandboxId::new_v4();
    let current_sandbox_id = SandboxId::new_v4();

    tracker.write_initial().await.unwrap();
    tracker.add_run(run_id, old_sandbox_id).await.unwrap();
    tracker.add_run(run_id, current_sandbox_id).await.unwrap();

    assert!(
        !tracker
            .remove_run_if_matching(run_id, old_sandbox_id)
            .await
            .unwrap()
    );

    let status = read_status(&path);
    let runs = status["active_runs"].as_array().unwrap();
    assert_eq!(runs.len(), 1);
    assert_eq!(runs[0]["run_id"], run_id.to_string());
    assert_eq!(runs[0]["sandbox_id"], current_sandbox_id.to_string());

    assert!(
        tracker
            .remove_run_if_matching(run_id, current_sandbox_id)
            .await
            .unwrap()
    );

    let status = read_status(&path);
    assert!(status["active_runs"].as_array().unwrap().is_empty());
}

#[tokio::test]
async fn proxy_port_in_status() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("status.json");
    let tracker = StatusTracker::new(path.clone(), 4, Some(8080), None);
    tracker.write_initial().await.unwrap();

    let status = read_status(&path);
    assert_eq!(status["proxy_port"], 8080);
}

#[tokio::test]
async fn proxy_port_absent_when_not_set() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("status.json");
    let tracker = StatusTracker::new(path.clone(), 4, None, None);

    tracker.write_initial().await.unwrap();

    let status = read_status(&path);
    assert!(status.get("proxy_port").is_none());
}

#[tokio::test]
async fn timestamps_are_iso8601() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("status.json");
    let tracker = StatusTracker::new(path.clone(), 4, None, None);

    tracker.write_initial().await.unwrap();

    let status = read_status(&path);
    let started = status["started_at"].as_str().unwrap();
    // ISO 8601 format: YYYY-MM-DDTHH:MM:SS.mmmZ
    assert!(started.ends_with('Z'));
    assert!(started.contains('T'));
    assert_eq!(started.len(), 24); // "2026-02-10T12:34:56.789Z"
}

#[tokio::test]
async fn set_idle_snapshot_round_trip() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("status.json");
    let tracker = StatusTracker::new(path.clone(), 4, None, None);

    tracker.write_initial().await.unwrap();

    let status = read_status(&path);
    assert!(status.get("idle_sandboxes").is_none());

    let sb1 = SandboxId::new_v4();
    let sb2 = SandboxId::new_v4();
    assert!(
        tracker
            .set_idle_snapshot(IdlePoolSnapshot {
                revision: 1,
                idle_sandboxes: vec![
                    IdleSandbox {
                        reuse_key: "sess-1".into(),
                        sandbox_id: sb1,
                    },
                    IdleSandbox {
                        reuse_key: "sess-2".into(),
                        sandbox_id: sb2,
                    },
                ],
                ..Default::default()
            })
            .await
            .unwrap()
    );

    let status = read_status(&path);
    let sandboxes = status["idle_sandboxes"].as_array().unwrap();
    assert_eq!(sandboxes.len(), 2);
    assert_eq!(sandboxes[0]["reuse_key"], "sess-1");
    assert_eq!(sandboxes[0]["sandbox_id"], sb1.to_string());
    assert_eq!(sandboxes[1]["reuse_key"], "sess-2");
    assert_eq!(sandboxes[1]["sandbox_id"], sb2.to_string());
}

#[tokio::test]
async fn stale_idle_info_revision_does_not_overwrite_newer_snapshot() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("status.json");
    let tracker = StatusTracker::new(path.clone(), 4, None, None);
    let stale_id = SandboxId::new_v4();
    let fresh_id = SandboxId::new_v4();

    tracker.write_initial().await.unwrap();
    assert!(
        tracker
            .set_idle_snapshot(IdlePoolSnapshot {
                revision: 2,
                idle_sandboxes: vec![IdleSandbox {
                    reuse_key: "fresh".into(),
                    sandbox_id: fresh_id,
                }],
                ..Default::default()
            })
            .await
            .unwrap()
    );
    assert!(
        !tracker
            .set_idle_snapshot(IdlePoolSnapshot {
                revision: 1,
                idle_sandboxes: vec![IdleSandbox {
                    reuse_key: "stale".into(),
                    sandbox_id: stale_id,
                }],
                ..Default::default()
            })
            .await
            .unwrap()
    );

    let status = read_status(&path);
    let sandboxes = status["idle_sandboxes"].as_array().unwrap();
    assert_eq!(sandboxes.len(), 1);
    assert_eq!(sandboxes[0]["reuse_key"], "fresh");
    assert_eq!(sandboxes[0]["sandbox_id"], fresh_id.to_string());
}

#[tokio::test]
async fn blank_claim_restore_and_drain_publish_one_revisioned_inventory() {
    use crate::idle_pool::test_support::ParkedIdleCandidateBuilder;
    use crate::idle_pool::{
        IdlePool, IdlePoolConfig, ParkResult, ParkedIdleCandidate, RestoreReservedIdleResult,
    };
    use crate::resource_budget::ResourceBudget;

    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("status.json");
    let tracker = StatusTracker::new(path.clone(), 4, None, None);
    let budget = Arc::new(ResourceBudget::new(16, 32_768, 1.0, 0));
    let mut pool = IdlePool::new(IdlePoolConfig { max_idle: 2 });
    let exact_id = SandboxId::new_v4();
    let blank_id = SandboxId::new_v4();
    assert!(matches!(
        pool.park(
            ParkedIdleCandidateBuilder::new(
                "thread:exact",
                ResourceBudget::try_reserve_lease(&budget, 2, 2048).unwrap()
            )
            .with_sandbox_id(exact_id)
            .build()
        ),
        ParkResult::Parked
    ));
    assert!(matches!(
        pool.park(ParkedIdleCandidate::blank(
            Box::new(sandbox_mock::MockSandbox::new(blank_id.to_string())),
            Arc::new(Box::new(sandbox_mock::MockSandboxFactory::new())),
            ResourceBudget::try_reserve_lease(&budget, 2, 2048).unwrap(),
            blank_id,
            "vm0/default".into(),
            "test-rootfs".into(),
            None,
        )),
        ParkResult::Parked
    ));

    let ready = pool.status_snapshot();
    tracker.set_idle_snapshot(ready.clone()).await.unwrap();
    let wire = read_status(&path);
    assert_eq!(
        wire["idle_sandboxes"],
        serde_json::json!([{
            "reuse_key": "thread:exact", "sandbox_id": exact_id.to_string()
        }])
    );
    assert_eq!(
        wire["blank_sandboxes"],
        serde_json::json!([{
            "sandbox_id": blank_id.to_string()
        }])
    );
    assert_eq!(wire["idle_sandboxes"].as_array().unwrap().len(), 1);
    assert_eq!(
        wire["blank_sandboxes"][0]["sandbox_id"],
        blank_id.to_string()
    );
    assert!(wire["active_runs"].as_array().unwrap().is_empty());

    let Ok(reservation) = pool.reserve_blank("vm0/default", &None) else {
        panic!("compatible blank should reserve");
    };
    assert!(reservation.reuse_key().is_none());
    let claimed = pool.status_snapshot();
    let run_id = RunId::new_v4();
    tracker
        .add_preparing_run_with_idle_snapshot(run_id, blank_id, claimed.clone())
        .await
        .unwrap();
    assert!(!tracker.set_idle_snapshot(ready).await.unwrap());
    let wire = read_status(&path);
    assert!(wire.get("blank_sandboxes").is_none());
    assert_eq!(wire["idle_sandboxes"].as_array().unwrap().len(), 1);
    assert_eq!(wire["active_runs"][0]["sandbox_id"], blank_id.to_string());
    assert_eq!(wire["active_runs"][0]["phase"], "preparing");

    assert!(matches!(
        pool.restore_reserved(reservation),
        RestoreReservedIdleResult::Restored
    ));
    let restored = pool.status_snapshot();
    tracker.set_idle_snapshot(restored.clone()).await.unwrap();
    tracker
        .remove_run_if_matching(run_id, blank_id)
        .await
        .unwrap();
    assert!(!tracker.set_idle_snapshot(claimed).await.unwrap());
    let wire = read_status(&path);
    assert!(wire["active_runs"].as_array().unwrap().is_empty());
    assert_eq!(
        wire["idle_sandboxes"][0]["sandbox_id"],
        exact_id.to_string()
    );
    assert_eq!(
        wire["blank_sandboxes"][0]["sandbox_id"],
        blank_id.to_string()
    );
    assert_eq!(budget.allocated().2, 2);

    let cleanup = pool.drain();
    tracker
        .set_idle_snapshot(pool.status_snapshot())
        .await
        .unwrap();
    assert!(!tracker.set_idle_snapshot(restored).await.unwrap());
    let wire = read_status(&path);
    assert!(wire.get("idle_sandboxes").is_none());
    assert!(wire.get("blank_sandboxes").is_none());
    for job in cleanup {
        job.run().await;
    }
    assert_eq!(budget.allocated().2, 0);
}

#[tokio::test]
async fn delayed_cleanup_snapshot_does_not_overwrite_newer_replacement_snapshot() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("status.json");
    let tracker = StatusTracker::new(path.clone(), 4, None, None);
    let original_id = SandboxId::new_v4();
    let replacement_id = SandboxId::new_v4();

    tracker.write_initial().await.unwrap();
    assert!(
        tracker
            .set_idle_snapshot(IdlePoolSnapshot {
                revision: 1,
                idle_sandboxes: vec![IdleSandbox {
                    reuse_key: "sess-replaced".into(),
                    sandbox_id: original_id,
                }],
                ..Default::default()
            })
            .await
            .unwrap()
    );

    // A cleanup/pressure eviction path captured this empty snapshot after
    // removing the original sandbox, then got delayed before publishing it.
    let delayed_cleanup_revision = 2;
    let delayed_cleanup_snapshot = Vec::new();

    // Meanwhile the same reuse key is parked again with a newer sandbox.
    assert!(
        tracker
            .set_idle_snapshot(IdlePoolSnapshot {
                revision: 3,
                idle_sandboxes: vec![IdleSandbox {
                    reuse_key: "sess-replaced".into(),
                    sandbox_id: replacement_id,
                }],
                ..Default::default()
            })
            .await
            .unwrap()
    );

    assert!(
        !tracker
            .set_idle_snapshot(IdlePoolSnapshot {
                revision: delayed_cleanup_revision,
                idle_sandboxes: delayed_cleanup_snapshot,
                ..Default::default()
            })
            .await
            .unwrap()
    );

    let status = read_status(&path);
    let sandboxes = status["idle_sandboxes"].as_array().unwrap();
    assert_eq!(sandboxes.len(), 1);
    assert_eq!(sandboxes[0]["reuse_key"], "sess-replaced");
    assert_eq!(sandboxes[0]["sandbox_id"], replacement_id.to_string());
}

#[tokio::test]
async fn add_run_with_idle_info_revision_preserves_newer_idle_snapshot() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("status.json");
    let tracker = StatusTracker::new(path.clone(), 4, None, None);
    let idle_id = SandboxId::new_v4();
    let stale_id = SandboxId::new_v4();
    let run_id = RunId::new_v4();
    let active_id = SandboxId::new_v4();

    tracker.write_initial().await.unwrap();
    assert!(
        tracker
            .set_idle_snapshot(IdlePoolSnapshot {
                revision: 2,
                idle_sandboxes: vec![IdleSandbox {
                    reuse_key: "fresh".into(),
                    sandbox_id: idle_id,
                }],
                ..Default::default()
            })
            .await
            .unwrap()
    );
    assert!(
        !tracker
            .add_running_run_with_idle_snapshot(
                run_id,
                active_id,
                IdlePoolSnapshot {
                    revision: 1,
                    idle_sandboxes: vec![IdleSandbox {
                        reuse_key: "stale".into(),
                        sandbox_id: stale_id,
                    }],
                    ..Default::default()
                }
            )
            .await
            .unwrap()
    );

    let status = read_status(&path);
    let runs = status["active_runs"].as_array().unwrap();
    assert_eq!(runs.len(), 1);
    assert_eq!(runs[0]["run_id"], run_id.to_string());
    assert_eq!(runs[0]["sandbox_id"], active_id.to_string());
    assert_eq!(runs[0]["phase"], "running");
    let sandboxes = status["idle_sandboxes"].as_array().unwrap();
    assert_eq!(sandboxes.len(), 1);
    assert_eq!(sandboxes[0]["reuse_key"], "fresh");
    assert_eq!(sandboxes[0]["sandbox_id"], idle_id.to_string());
}

#[tokio::test]
async fn add_preparing_run_with_idle_info_revision_records_preparing_phase() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("status.json");
    let tracker = StatusTracker::new(path.clone(), 4, None, None);
    let idle_id = SandboxId::new_v4();
    let run_id = RunId::new_v4();
    let active_id = SandboxId::new_v4();

    tracker.write_initial().await.unwrap();
    assert!(
        tracker
            .add_preparing_run_with_idle_snapshot(
                run_id,
                active_id,
                IdlePoolSnapshot {
                    revision: 1,
                    idle_sandboxes: vec![IdleSandbox {
                        reuse_key: "fresh-create-after-reuse-miss".into(),
                        sandbox_id: idle_id,
                    }],
                    ..Default::default()
                }
            )
            .await
            .unwrap()
    );

    let status = read_status(&path);
    let runs = status["active_runs"].as_array().unwrap();
    assert_eq!(runs.len(), 1);
    assert_eq!(runs[0]["run_id"], run_id.to_string());
    assert_eq!(runs[0]["sandbox_id"], active_id.to_string());
    assert_eq!(runs[0]["phase"], "preparing");
    let sandboxes = status["idle_sandboxes"].as_array().unwrap();
    assert_eq!(sandboxes.len(), 1);
    assert_eq!(sandboxes[0]["reuse_key"], "fresh-create-after-reuse-miss");
    assert_eq!(sandboxes[0]["sandbox_id"], idle_id.to_string());
}

#[tokio::test]
async fn set_idle_snapshot_empty_omitted() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("status.json");
    let tracker = StatusTracker::new(path.clone(), 4, None, None);

    assert!(
        tracker
            .set_idle_snapshot(IdlePoolSnapshot {
                revision: 1,
                idle_sandboxes: vec![],
                ..Default::default()
            })
            .await
            .unwrap()
    );

    let status = read_status(&path);
    assert!(
        status.get("idle_sandboxes").is_none(),
        "empty idle_sandboxes should be omitted from JSON"
    );
}
