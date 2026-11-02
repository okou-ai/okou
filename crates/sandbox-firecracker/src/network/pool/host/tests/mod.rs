use super::*;
use std::sync::atomic::AtomicUsize;

use tokio::sync::Semaphore;

const TEST_SYNC_TIMEOUT: Duration = Duration::from_secs(5);

async fn wait_for_test_sync<T>(phase: &'static str, future: impl Future<Output = T>) -> T {
    match tokio::time::timeout(TEST_SYNC_TIMEOUT, future).await {
        Ok(value) => value,
        Err(_) => panic!("test synchronization timed out waiting for {phase}"),
    }
}

fn namespace_resources_for_test(count: usize) -> Vec<NamespaceResources> {
    (0..count)
        .map(|index| NamespaceResources {
            name: format!("vm0-ns-test-{index:02x}"),
            host_device: format!("vm0-ve-test-{index:02x}"),
        })
        .collect()
}

#[tokio::test]
async fn namespace_resource_deletion_uses_fixed_concurrency_window() {
    let count = NAMESPACE_DELETE_CONCURRENCY + 2;
    let active = Arc::new(AtomicUsize::new(0));
    let peak = Arc::new(AtomicUsize::new(0));
    let completed = Arc::new(AtomicUsize::new(0));
    let started = Arc::new(Semaphore::new(0));
    let release = Arc::new(Semaphore::new(0));
    let cleanup = tokio::spawn(delete_namespace_resources_bounded_with(
        namespace_resources_for_test(count),
        {
            let active = Arc::clone(&active);
            let peak = Arc::clone(&peak);
            let completed = Arc::clone(&completed);
            let started = Arc::clone(&started);
            let release = Arc::clone(&release);
            move |_, _| {
                let active = Arc::clone(&active);
                let peak = Arc::clone(&peak);
                let completed = Arc::clone(&completed);
                let started = Arc::clone(&started);
                let release = Arc::clone(&release);
                async move {
                    let current = active.fetch_add(1, Ordering::SeqCst) + 1;
                    peak.fetch_max(current, Ordering::SeqCst);
                    started.add_permits(1);
                    release.acquire().await.unwrap().forget();
                    active.fetch_sub(1, Ordering::SeqCst);
                    completed.fetch_add(1, Ordering::SeqCst);
                    NamespaceDeleteOutcome::Deleted
                }
            }
        },
    ));

    for _ in 0..NAMESPACE_DELETE_CONCURRENCY {
        wait_for_test_sync(
            "namespace deletion to enter the fixed window",
            started.acquire(),
        )
        .await
        .unwrap()
        .forget();
    }
    assert_eq!(active.load(Ordering::SeqCst), NAMESPACE_DELETE_CONCURRENCY);
    assert_eq!(peak.load(Ordering::SeqCst), NAMESPACE_DELETE_CONCURRENCY);
    assert_eq!(started.available_permits(), 0);

    release.add_permits(count);
    let outcome = wait_for_test_sync("namespace deletion batch to complete", cleanup)
        .await
        .unwrap();

    assert_eq!(outcome, NamespaceDeleteOutcome::Deleted);
    assert_eq!(active.load(Ordering::SeqCst), 0);
    assert_eq!(peak.load(Ordering::SeqCst), NAMESPACE_DELETE_CONCURRENCY);
    assert_eq!(completed.load(Ordering::SeqCst), count);
}

#[tokio::test]
async fn namespace_resource_deletion_aggregates_partial_failure() {
    let count = NAMESPACE_DELETE_CONCURRENCY + 2;
    let attempts = Arc::new(AtomicUsize::new(0));
    let failed_name = "vm0-ns-test-03";

    let outcome = delete_namespace_resources_bounded_with(namespace_resources_for_test(count), {
        let attempts = Arc::clone(&attempts);
        move |name, _| {
            let attempts = Arc::clone(&attempts);
            async move {
                attempts.fetch_add(1, Ordering::SeqCst);
                if name == failed_name {
                    NamespaceDeleteOutcome::Abandoned
                } else {
                    NamespaceDeleteOutcome::Deleted
                }
            }
        }
    })
    .await;

    assert_eq!(outcome, NamespaceDeleteOutcome::Abandoned);
    assert_eq!(attempts.load(Ordering::SeqCst), count);
}

#[tokio::test]
async fn namespace_resource_deletion_aggregates_task_panic() {
    let outcome = delete_namespace_resources_bounded_with(
        namespace_resources_for_test(3),
        |name, _| async move {
            assert_ne!(name, "vm0-ns-test-01", "synthetic deletion panic");
            NamespaceDeleteOutcome::Deleted
        },
    )
    .await;

    assert_eq!(outcome, NamespaceDeleteOutcome::Abandoned);
}

#[tokio::test]
async fn cancelling_namespace_resource_deletion_aborts_in_flight_tasks() {
    struct NotifyOnDrop(Arc<Semaphore>);

    impl Drop for NotifyOnDrop {
        fn drop(&mut self) {
            self.0.add_permits(1);
        }
    }

    let started = Arc::new(Semaphore::new(0));
    let dropped = Arc::new(Semaphore::new(0));
    let cleanup = tokio::spawn(delete_namespace_resources_bounded_with(
        namespace_resources_for_test(NAMESPACE_DELETE_CONCURRENCY + 1),
        {
            let started = Arc::clone(&started);
            let dropped = Arc::clone(&dropped);
            move |_, _| {
                let started = Arc::clone(&started);
                let dropped = Arc::clone(&dropped);
                async move {
                    let _drop = NotifyOnDrop(dropped);
                    started.add_permits(1);
                    std::future::pending::<NamespaceDeleteOutcome>().await
                }
            }
        },
    ));

    for _ in 0..NAMESPACE_DELETE_CONCURRENCY {
        wait_for_test_sync(
            "namespace deletion to start before cancellation",
            started.acquire(),
        )
        .await
        .unwrap()
        .forget();
    }
    cleanup.abort();
    let error = wait_for_test_sync("cancelled deletion batch to stop", cleanup)
        .await
        .unwrap_err();
    assert!(error.is_cancelled());
    for _ in 0..NAMESPACE_DELETE_CONCURRENCY {
        wait_for_test_sync(
            "in-flight namespace deletion to be dropped",
            dropped.acquire(),
        )
        .await
        .unwrap()
        .forget();
    }
}

#[test]
fn namespace_delete_outcome_abandons_uncertain_commands() {
    assert_eq!(
        namespace_delete_outcome_from_best_effort([
            IgnoredCommandOutcome::Success,
            IgnoredCommandOutcome::NonZero,
        ]),
        NamespaceDeleteOutcome::Deleted
    );

    for outcome in [
        IgnoredCommandOutcome::NotFound,
        IgnoredCommandOutcome::SpawnError,
        IgnoredCommandOutcome::WaitError,
        IgnoredCommandOutcome::PipeError,
        IgnoredCommandOutcome::OutputTooLarge,
        IgnoredCommandOutcome::Timeout,
        IgnoredCommandOutcome::LifecycleError,
    ] {
        assert_eq!(
            namespace_delete_outcome_from_best_effort([IgnoredCommandOutcome::Success, outcome,]),
            NamespaceDeleteOutcome::Abandoned,
            "uncertain command outcome was treated as deleted: {outcome:?}"
        );
    }
}

#[tokio::test]
async fn conntrack_flush_trusts_success_and_verified_zero_delete() {
    let success = exec_status_with_timeout("true", &[], Duration::from_secs(1)).await;
    let zero_delete = exec_status_with_timeout(
            "sh",
            &[
                "-c",
                "printf '%s\\n' 'conntrack v1.4.8 (conntrack-tools): 0 flow entries have been deleted.' >&2; exit 1",
            ],
            Duration::from_secs(1),
        )
        .await;

    assert!(conntrack_delete_is_trusted(&success));
    assert!(conntrack_delete_is_trusted(&zero_delete));
    assert!(conntrack_flush_is_trusted(&success, &zero_delete));
    assert!(conntrack_flush_is_trusted(&zero_delete, &success));
}

#[tokio::test]
async fn conntrack_flush_rejects_command_failures_and_invalid_invocations() {
    let command_failure = exec_status_with_timeout(
        "sh",
        &["-c", "printf 'permission denied\\n' >&2; exit 1"],
        Duration::from_secs(1),
    )
    .await;
    let invalid_invocation = exec_status_with_timeout(
            "sh",
            &[
                "-c",
                "printf '%s\\n' 'conntrack v1.4.8 (conntrack-tools): 0 flow entries have been deleted.' >&2; exit 2",
            ],
            Duration::from_secs(1),
        )
        .await;

    assert!(!conntrack_delete_is_trusted(&command_failure));
    assert!(!conntrack_delete_is_trusted(&invalid_invocation));
    assert!(!conntrack_flush_is_trusted(
        &command_failure,
        &invalid_invocation
    ));
}

#[tokio::test]
async fn conntrack_flush_rejects_missing_command_timeout_and_partial_success() {
    let success = exec_status_with_timeout("true", &[], Duration::from_secs(1)).await;
    let missing = exec_status_with_timeout(
        "vm0-definitely-missing-conntrack-command",
        &[],
        Duration::from_millis(50),
    )
    .await;
    let timeout =
        exec_status_with_timeout("sh", &["-c", "sleep 2"], Duration::from_millis(50)).await;

    assert!(!conntrack_delete_is_trusted(&missing));
    assert!(!conntrack_delete_is_trusted(&timeout));
    assert!(!conntrack_flush_is_trusted(&success, &missing));
    assert!(!conntrack_flush_is_trusted(&timeout, &success));
}

#[test]
fn conntrack_zero_delete_requires_exact_single_line_diagnostic() {
    let misleading_prefix = Err(CommandError {
        command: "conntrack -D -s 10.0.0.2".to_string(),
        exit_code: Some(1),
        detail: "not-conntrack v1.4.8 (conntrack-tools): 0 flow entries have been deleted."
            .to_string(),
    });
    let multiline = Err(CommandError {
        command: "conntrack -D -s 10.0.0.2".to_string(),
        exit_code: Some(1),
        detail: "warning\nconntrack v1.4.8 (conntrack-tools): 0 flow entries have been deleted."
            .to_string(),
    });
    let truncated = Err(CommandError {
            command: "conntrack -D -s 10.0.0.2".to_string(),
            exit_code: Some(1),
            detail: "conntrack v1.4.8 (conntrack-tools): 0 flow entries have been deleted.\n[output truncated]"
                .to_string(),
        });

    assert!(!conntrack_delete_is_trusted(&misleading_prefix));
    assert!(!conntrack_delete_is_trusted(&multiline));
    assert!(!conntrack_delete_is_trusted(&truncated));
}

#[test]
fn acquire_pool_lock_returns_first_available() {
    let dir = tempfile::tempdir().unwrap();
    let locks = LockPaths::with_dir(dir.path().to_path_buf());

    let (index, _lock) = acquire_pool_lock(&locks).unwrap();
    assert_eq!(index, 0);
}

#[test]
fn acquire_pool_lock_skips_held_indices() {
    let dir = tempfile::tempdir().unwrap();
    let locks = LockPaths::with_dir(dir.path().to_path_buf());

    let (i0, _hold0) = acquire_pool_lock(&locks).unwrap();
    let (i1, _hold1) = acquire_pool_lock(&locks).unwrap();
    let (i2, _hold2) = acquire_pool_lock(&locks).unwrap();

    assert_eq!(i0, 0);
    assert_eq!(i1, 1);
    assert_eq!(i2, 2);
}

#[test]
fn acquire_pool_lock_reuses_released_index() {
    let dir = tempfile::tempdir().unwrap();
    let locks = LockPaths::with_dir(dir.path().to_path_buf());

    let held_idx = 0;
    let held = Flock::lock(
        File::create(locks.netns_pool(held_idx)).unwrap(),
        FlockArg::LockExclusiveNonblock,
    )
    .unwrap();

    let (available_idx, _available) = acquire_pool_lock(&locks).unwrap();
    assert_eq!(available_idx, 1);

    // Flock's explicit LOCK_UN makes release deterministic across forks.
    drop(held);

    let (reused_idx, _reused) = acquire_pool_lock(&locks).unwrap();
    assert_eq!(reused_idx, held_idx);
}

#[test]
fn try_claim_idle_pool_lock_returns_none_when_file_missing() {
    let dir = tempfile::tempdir().unwrap();
    let locks = LockPaths::with_dir(dir.path().to_path_buf());
    // No lock file has ever been created for index 0.
    assert!(try_claim_idle_pool_lock(&locks, 0).is_none());
}

#[test]
fn try_claim_idle_pool_lock_returns_none_when_held() {
    let dir = tempfile::tempdir().unwrap();
    let locks = LockPaths::with_dir(dir.path().to_path_buf());

    let (idx, _held) = acquire_pool_lock(&locks).unwrap();
    assert!(try_claim_idle_pool_lock(&locks, idx).is_none());
}

#[test]
fn try_claim_idle_pool_lock_returns_some_when_idle() {
    let dir = tempfile::tempdir().unwrap();
    let locks = LockPaths::with_dir(dir.path().to_path_buf());

    let idx = 0;
    // Construct the idle state directly. A close-only PoolIndexLock can be
    // briefly retained by an unrelated concurrent fork.
    File::create(locks.netns_pool(idx)).unwrap();

    let claimed = try_claim_idle_pool_lock(&locks, idx);
    assert!(claimed.is_some());
}

#[test]
fn acquire_pool_lock_exhausted() {
    let dir = tempfile::tempdir().unwrap();
    let locks = LockPaths::with_dir(dir.path().to_path_buf());

    // Hold all 64 slots.
    let _locks: Vec<_> = (0..MAX_POOLS)
        .map(|_| acquire_pool_lock(&locks).unwrap())
        .collect();

    let err = acquire_pool_lock(&locks).unwrap_err();
    assert!(
        matches!(err, NetworkError::NoPoolIndexAvailable),
        "expected NoPoolIndexAvailable, got: {err}"
    );
}
