use super::*;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

use nix::fcntl::FlockArg;
use runner_host::paths::RunnerPaths;
use runner_storage::SandboxOpReporter;
use tracing_subscriber::prelude::*;
use tracing_test_support::CapturedEvents;

#[tokio::test]
async fn last_custody_release_precedes_reporting_even_after_owner_transitions() {
    let local = CapturedEvents::default();
    let _subscriber = tracing::subscriber::set_default(
        tracing_subscriber::registry().with(
            local
                .clone()
                .with_filter(tracing::level_filters::LevelFilter::INFO),
        ),
    );
    let dir = tempfile::tempdir().unwrap();
    let cache = HomeImageCache::new(RunnerPaths::new(dir.path().join("runner")));
    let key = cache.scoped_cache_key("vm0/default", "thread:lock-timing", 1024 * 1024);
    let path = cache.entry_lock_path(&key);
    let inner = cache.inner.clone();
    let released = Arc::new(AtomicBool::new(false));
    let count = Arc::new(AtomicUsize::new(0));
    let observed_release = released.clone();
    let observed_count = count.clone();
    let acquiring_run_id = RunId::new_v4();
    let expected_key = key.clone();
    let expected_path = path.clone();
    let cache = cache.with_telemetry(SandboxOpReporter::new(|_| async {}).with_record(
        move |record| {
            let home = record.home.as_ref().unwrap();
            if home.reason.as_deref() != Some("entry_lock_lifetime") {
                return;
            }
            observed_count.fetch_add(1, Ordering::SeqCst);
            let file = std::fs::OpenOptions::new()
                .read(true)
                .write(true)
                .open(&expected_path)
                .unwrap();
            let physical = Flock::lock(file, FlockArg::LockExclusiveNonblock);
            let registered = inner
                .entry_lock_owners
                .lock()
                .unwrap()
                .contains_key(&expected_key);
            observed_release.store(
                physical.is_ok()
                    && !registered
                    && home.run_id == Some(acquiring_run_id)
                    && home.cache_key.as_deref() == Some(expected_key.as_str())
                    && home.outcome == HomeObservationOutcome::Released,
                Ordering::SeqCst,
            );
        },
    ));
    let flock = runner_host::lock::try_acquire(path.clone()).await.unwrap();
    let entry = HomeEntryLock::new(
        &cache,
        &key,
        flock,
        HomeCacheLockOwner::Active,
        acquiring_run_id,
    );
    let mut retained = entry.clone();
    retained.set_owner(HomeCacheLockOwner::Finalizing);
    drop(entry);
    assert_eq!(count.load(Ordering::SeqCst), 0);
    assert!(matches!(
        runner_host::lock::try_acquire_or_busy(path).await.unwrap(),
        runner_host::lock::TryLock::Busy
    ));
    retained.set_owner(HomeCacheLockOwner::Active);
    drop(retained);
    assert_eq!(count.load(Ordering::SeqCst), 1);
    assert!(
        released.load(Ordering::SeqCst),
        "reporting must observe real release and original custody identity"
    );
    assert!(
        local.entries().iter().all(|event| {
            event
                .fields
                .get("op_type")
                .is_none_or(|op| op != "runner_home_lifecycle_timing")
        }),
        "buffered phase reporting must not add output through Runner's INFO writer"
    );
}

#[tokio::test]
async fn reporting_panic_during_unwind_cannot_abort_cleanup_or_keep_the_lock() {
    let dir = tempfile::tempdir().unwrap();
    let callback = Arc::new(AtomicBool::new(false));
    let observed = callback.clone();
    let cache = HomeImageCache::new(RunnerPaths::new(dir.path().join("runner"))).with_telemetry(
        SandboxOpReporter::new(|_| async {}).with_record(move |_| {
            observed.store(true, Ordering::SeqCst);
            panic!("simulated optional reporter failure");
        }),
    );
    let key = cache.scoped_cache_key("vm0/default", "thread:unwind", 1024 * 1024);
    let path = cache.entry_lock_path(&key);
    let flock = runner_host::lock::try_acquire(path.clone()).await.unwrap();
    let entry = HomeEntryLock::new(
        &cache,
        &key,
        flock,
        HomeCacheLockOwner::Active,
        RunId::new_v4(),
    );
    let failure = std::panic::catch_unwind(std::panic::AssertUnwindSafe(move || {
        let _entry = entry;
        panic!("original cleanup unwind");
    }));
    let original = failure.unwrap_err();
    assert_eq!(
        original.downcast_ref::<&str>(),
        Some(&"original cleanup unwind")
    );
    assert!(callback.load(Ordering::SeqCst));
    assert!(
        !cache
            .inner
            .entry_lock_owners
            .lock()
            .unwrap()
            .contains_key(&key)
    );
    let _physical = runner_host::lock::try_acquire(path).await.unwrap();
}
