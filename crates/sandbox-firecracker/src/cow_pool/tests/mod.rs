use super::create::{CowFileConfig, create_slot, create_slot_with_copy_timeout};
use super::state::CowPool;
use super::*;
use std::collections::VecDeque;
use std::ffi::OsString;
use std::os::unix::ffi::OsStringExt;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant as StdInstant};

use tokio::sync::oneshot;

fn test_config(dir: &Path) -> CowPoolConfig {
    CowPoolConfig {
        workspaces_dir: dir.to_owned(),
        base_image: dir.join("base.img"),
        base_size: 64 * 1024 * 1024,
        golden_cow: None,
        device_pool: nbd_cow::pool::DevicePoolHandle::new(
            nbd_cow::pool::DevicePoolConfig::default(),
        ),
    }
}

fn test_file_config(dir: &Path) -> CowFileConfig {
    CowFileConfig {
        workspaces_dir: dir.to_owned(),
        base_size: 64 * 1024 * 1024,
        golden_cow: None,
    }
}

fn write_bitmap_file(path: &Path, blocks: u64, word: u64) {
    let mut data = blocks.to_le_bytes().to_vec();
    data.extend_from_slice(&word.to_le_bytes());
    std::fs::write(path, data).unwrap();
}

fn raw_test_slot(dir: &Path, id: &str) -> PrewarmedSlot {
    let workspace = dir.join(id);
    std::fs::create_dir_all(&workspace).unwrap();
    std::fs::write(workspace.join("cow.img"), b"cow").unwrap();
    PrewarmedSlot::new(id.to_owned(), workspace)
}

fn test_slot(dir: &Path, id: &str) -> PreparedCowSlot {
    PreparedCowSlot::new_for_test(raw_test_slot(dir, id))
}

fn raw_test_slot_with_drop_notify(
    dir: &Path,
    id: &str,
) -> (PrewarmedSlot, oneshot::Receiver<PathBuf>) {
    let (drop_notify, dropped) = oneshot::channel();
    let mut slot = raw_test_slot(dir, id);
    slot.drop_notify = Some(drop_notify);
    (slot, dropped)
}

fn test_slot_with_drop_notify(
    dir: &Path,
    id: &str,
) -> (PreparedCowSlot, oneshot::Receiver<PathBuf>) {
    let (slot, dropped) = raw_test_slot_with_drop_notify(dir, id);
    (PreparedCowSlot::new_for_test(slot), dropped)
}

fn raw_test_slot_with_teardown_gate(
    dir: &Path,
    id: &str,
) -> (
    PrewarmedSlot,
    oneshot::Receiver<PathBuf>,
    std::sync::mpsc::Sender<()>,
    oneshot::Receiver<PathBuf>,
) {
    let (teardown_started, started) = oneshot::channel();
    let (release, teardown_release) = std::sync::mpsc::channel();
    let (mut slot, dropped) = raw_test_slot_with_drop_notify(dir, id);
    slot.set_teardown_gate(teardown_started, teardown_release);
    (slot, started, release, dropped)
}

fn test_slot_with_teardown_gate(
    dir: &Path,
    id: &str,
) -> (
    PreparedCowSlot,
    oneshot::Receiver<PathBuf>,
    std::sync::mpsc::Sender<()>,
    oneshot::Receiver<PathBuf>,
) {
    let (slot, started, release, dropped) = raw_test_slot_with_teardown_gate(dir, id);
    (
        PreparedCowSlot::new_for_test(slot),
        started,
        release,
        dropped,
    )
}

fn test_pool_with_spawner(
    config: CowPoolConfig,
    buffer_size: usize,
    max_concurrent_creations: usize,
    max_slots: usize,
    warm_retry_backoff: Duration,
    slot_spawner: SlotSpawner,
) -> CowPool {
    CowPool::new_with_options(
        config,
        buffer_size,
        max_concurrent_creations,
        max_slots,
        warm_retry_backoff,
        slot_spawner,
    )
}

type ControlledSlotRequest = oneshot::Sender<Result<PreparedCowSlot, CowPoolError>>;

struct ControlledSpawner {
    requests: Arc<Mutex<VecDeque<ControlledSlotRequest>>>,
}

impl ControlledSpawner {
    fn new() -> (Self, SlotSpawner) {
        let requests = Arc::new(Mutex::new(VecDeque::new()));
        let spawner_requests = Arc::clone(&requests);
        let spawner: SlotSpawner = Arc::new(move |_config| {
            let (complete, complete_rx) = oneshot::channel();
            spawner_requests.lock().unwrap().push_back(complete);
            tokio::spawn(async move {
                complete_rx
                    .await
                    .unwrap_or_else(|_| Err(CowPoolError::CowFileCreation("cancelled".into())))
            })
        });
        (Self { requests }, spawner)
    }

    fn take_request(&self) -> oneshot::Sender<Result<PreparedCowSlot, CowPoolError>> {
        self.requests
            .lock()
            .unwrap()
            .pop_front()
            .expect("missing slot creation request")
    }

    fn request_count(&self) -> usize {
        self.requests.lock().unwrap().len()
    }
}

async fn wait_for_snapshot<F>(handle: &CowPoolHandle, predicate: F) -> CowPoolSnapshot
where
    F: Fn(&CowPoolSnapshot) -> bool,
{
    let deadline = StdInstant::now() + Duration::from_secs(1);
    loop {
        let snapshot = handle.snapshot().await;
        if predicate(&snapshot) {
            return snapshot;
        }
        assert!(
            StdInstant::now() < deadline,
            "condition not reached; last snapshot: {snapshot:?}"
        );
        tokio::task::yield_now().await;
    }
}

#[tokio::test]
async fn warmup_creates_ready_slots() {
    let tmp = tempfile::tempdir().unwrap();
    let (controller, spawner) = ControlledSpawner::new();
    let pool = test_pool_with_spawner(
        test_config(tmp.path()),
        BUFFER_SIZE,
        MAX_CONCURRENT_SLOT_CREATIONS,
        MAX_SLOTS,
        Duration::ZERO,
        spawner,
    );
    let handle = CowPoolHandle::new_for_test(pool);

    let warmup = tokio::spawn({
        let handle = handle.clone();
        async move { handle.warmup().await }
    });
    for index in 0..BUFFER_SIZE {
        wait_for_snapshot(&handle, |snapshot| snapshot.pending > 0).await;
        controller
            .take_request()
            .send(Ok(test_slot(tmp.path(), &format!("warm-{index}"))))
            .unwrap();
    }
    warmup.await.unwrap();

    let snapshot = handle.snapshot().await;
    assert_eq!(snapshot.ready, BUFFER_SIZE);
    assert_eq!(snapshot.pending, 0);
    assert_eq!(snapshot.pipeline_slots, BUFFER_SIZE);
    handle.cleanup().await;
}

#[tokio::test]
async fn pipeline_slots_include_ready_and_pending_slots() {
    let tmp = tempfile::tempdir().unwrap();
    let (controller, spawner) = ControlledSpawner::new();
    let pool = test_pool_with_spawner(test_config(tmp.path()), 2, 1, 4, Duration::ZERO, spawner);
    let handle = CowPoolHandle::new_for_test(pool);

    let warmup = tokio::spawn({
        let handle = handle.clone();
        async move { handle.warmup().await }
    });
    wait_for_snapshot(&handle, |snapshot| {
        snapshot.ready == 0 && snapshot.pending == 1 && snapshot.pipeline_slots == 1
    })
    .await;

    controller
        .take_request()
        .send(Ok(test_slot(tmp.path(), "ready")))
        .unwrap();
    wait_for_snapshot(&handle, |snapshot| {
        snapshot.ready == 1 && snapshot.pending == 1 && snapshot.pipeline_slots == 2
    })
    .await;

    controller
        .take_request()
        .send(Ok(test_slot(tmp.path(), "pending")))
        .unwrap();
    warmup.await.unwrap();
    let snapshot = handle.snapshot().await;
    assert_eq!(snapshot.ready, 2);
    assert_eq!(snapshot.pending, 0);
    assert_eq!(snapshot.pipeline_slots, 2);
    handle.cleanup().await;
}

#[tokio::test]
async fn acquire_after_cleanup_returns_error() {
    let tmp = tempfile::tempdir().unwrap();
    let handle = CowPoolHandle::new(test_config(tmp.path()));

    handle.cleanup().await;

    let err = handle.acquire().await.unwrap_err();
    assert!(
        matches!(err, CowPoolError::ActorStopped | CowPoolError::NotActive),
        "unexpected error: {err}"
    );
}

#[tokio::test]
async fn burst_acquire_starts_bounded_slot_creations() {
    let tmp = tempfile::tempdir().unwrap();
    let (controller, spawner) = ControlledSpawner::new();
    let pool = test_pool_with_spawner(test_config(tmp.path()), 0, 2, 10, Duration::ZERO, spawner);
    let handle = CowPoolHandle::new_for_test(pool);

    let mut acquires = Vec::new();
    for _ in 0..5 {
        let handle = handle.clone();
        acquires.push(tokio::spawn(async move { handle.acquire().await }));
    }

    wait_for_snapshot(&handle, |snapshot| {
        snapshot.waiters == 5 && snapshot.pending == 2 && snapshot.pipeline_slots == 2
    })
    .await;
    assert_eq!(controller.request_count(), 2);

    for i in 0..5 {
        controller
            .take_request()
            .send(Ok(test_slot(tmp.path(), &format!("slot-{i}"))))
            .unwrap();
        if i < 3 {
            wait_for_snapshot(&handle, |snapshot| snapshot.pending > 0).await;
        }
    }

    for acquire in acquires {
        drop(acquire.await.unwrap().unwrap());
    }
    handle.cleanup().await;
}

#[tokio::test]
async fn checked_out_slot_stops_consuming_pipeline_capacity() {
    let tmp = tempfile::tempdir().unwrap();
    let (controller, spawner) = ControlledSpawner::new();
    let pool = test_pool_with_spawner(test_config(tmp.path()), 0, 1, 1, Duration::ZERO, spawner);
    let handle = CowPoolHandle::new_for_test(pool);

    let first = tokio::spawn({
        let handle = handle.clone();
        async move { handle.acquire().await }
    });
    wait_for_snapshot(&handle, |snapshot| snapshot.pending == 1).await;
    controller
        .take_request()
        .send(Ok(test_slot(tmp.path(), "first")))
        .unwrap();
    let first_slot = first.await.unwrap().unwrap();

    wait_for_snapshot(&handle, |snapshot| snapshot.pipeline_slots == 0).await;
    let second = tokio::spawn({
        let handle = handle.clone();
        async move { handle.acquire().await }
    });
    wait_for_snapshot(&handle, |snapshot| snapshot.pending == 1).await;
    controller
        .take_request()
        .send(Ok(test_slot(tmp.path(), "second")))
        .unwrap();
    let second_slot = second.await.unwrap().unwrap();

    drop(first_slot);
    drop(second_slot);
    handle.cleanup().await;
}

#[tokio::test]
async fn cancelled_acquire_does_not_lose_completed_slot() {
    let tmp = tempfile::tempdir().unwrap();
    let (controller, spawner) = ControlledSpawner::new();
    let pool = test_pool_with_spawner(test_config(tmp.path()), 0, 1, 4, Duration::ZERO, spawner);
    let handle = CowPoolHandle::new_for_test(pool);

    let first = tokio::spawn({
        let handle = handle.clone();
        async move { handle.acquire().await }
    });
    wait_for_snapshot(&handle, |snapshot| snapshot.pending == 1).await;
    first.abort();

    let second = tokio::spawn({
        let handle = handle.clone();
        async move { handle.acquire().await }
    });
    controller
        .take_request()
        .send(Ok(test_slot(tmp.path(), "survives-cancel")))
        .unwrap();

    let slot = second.await.unwrap().unwrap();
    assert_eq!(slot.id(), "survives-cancel");
    drop(slot);
    handle.cleanup().await;
}

#[tokio::test]
async fn cancelled_acquire_after_delivery_cleans_transferred_slot() {
    let tmp = tempfile::tempdir().unwrap();
    let (controller, spawner) = ControlledSpawner::new();
    let mut pool =
        test_pool_with_spawner(test_config(tmp.path()), 0, 1, 4, Duration::ZERO, spawner);
    let (respond_to, response) = oneshot::channel();
    pool.handle_acquire(StdInstant::now(), respond_to);

    let (slot, dropped) = test_slot_with_drop_notify(tmp.path(), "delivered-before-cancel");
    let workspace = slot.workspace().to_owned();
    while controller.request_count() == 0 {
        tokio::task::yield_now().await;
    }
    controller.take_request().send(Ok(slot)).unwrap();
    let completion = pool.pending.join_next().await;
    pool.handle_creation_join(completion);

    drop(response);

    assert_eq!(dropped.await.unwrap(), workspace);
    assert!(!workspace.exists());
    pool.cleanup().await;
}

#[tokio::test]
async fn cancelled_burst_does_not_leave_ready_slots_above_buffer() {
    let tmp = tempfile::tempdir().unwrap();
    let (controller, spawner) = ControlledSpawner::new();
    let pool = test_pool_with_spawner(test_config(tmp.path()), 1, 3, 8, Duration::ZERO, spawner);
    let handle = CowPoolHandle::new_for_test(pool);

    let first = tokio::spawn({
        let handle = handle.clone();
        async move { handle.acquire().await }
    });
    let second = tokio::spawn({
        let handle = handle.clone();
        async move { handle.acquire().await }
    });
    wait_for_snapshot(&handle, |snapshot| {
        snapshot.waiters == 2 && snapshot.pending == 3
    })
    .await;
    first.abort();
    second.abort();
    assert!(first.await.unwrap_err().is_cancelled());
    assert!(second.await.unwrap_err().is_cancelled());

    let (retained, retained_dropped) =
        test_slot_with_drop_notify(tmp.path(), "retained-buffer-slot");
    let retained_workspace = retained.workspace().to_owned();
    controller.take_request().send(Ok(retained)).unwrap();
    wait_for_snapshot(&handle, |snapshot| {
        snapshot.ready == 1 && snapshot.pending == 2 && snapshot.pipeline_slots == 3
    })
    .await;

    for index in 0..2 {
        let (slot, dropped) = test_slot_with_drop_notify(tmp.path(), &format!("surplus-{index}"));
        let workspace = slot.workspace().to_owned();
        controller.take_request().send(Ok(slot)).unwrap();
        assert_eq!(dropped.await.unwrap(), workspace);
        assert!(!workspace.exists());
    }

    wait_for_snapshot(&handle, |snapshot| {
        snapshot.ready == 1 && snapshot.pending == 0 && snapshot.pipeline_slots == 1
    })
    .await;

    handle.cleanup().await;
    assert_eq!(retained_dropped.await.unwrap(), retained_workspace);
    assert!(!retained_workspace.exists());
}

#[tokio::test]
async fn surplus_teardown_does_not_block_ready_acquire() {
    let tmp = tempfile::tempdir().unwrap();
    let (controller, spawner) = ControlledSpawner::new();
    let pool = test_pool_with_spawner(
        test_config(tmp.path()),
        1,
        2,
        4,
        Duration::from_secs(60),
        spawner,
    );
    let handle = CowPoolHandle::new_for_test(pool);

    let first = tokio::spawn({
        let handle = handle.clone();
        async move { handle.acquire().await }
    });
    let second = tokio::spawn({
        let handle = handle.clone();
        async move { handle.acquire().await }
    });
    wait_for_snapshot(&handle, |snapshot| {
        snapshot.waiters == 2 && snapshot.pending == 2
    })
    .await;
    first.abort();
    second.abort();
    assert!(first.await.unwrap_err().is_cancelled());
    assert!(second.await.unwrap_err().is_cancelled());

    let (retained, retained_dropped) =
        test_slot_with_drop_notify(tmp.path(), "ready-during-surplus-teardown");
    let retained_workspace = retained.workspace().to_owned();
    controller.take_request().send(Ok(retained)).unwrap();
    wait_for_snapshot(&handle, |snapshot| {
        snapshot.ready == 1 && snapshot.pending == 1
    })
    .await;

    let (surplus, teardown_started, release_teardown, surplus_dropped) =
        test_slot_with_teardown_gate(tmp.path(), "slow-surplus-teardown");
    let surplus_workspace = surplus.workspace().to_owned();
    controller.take_request().send(Ok(surplus)).unwrap();
    assert_eq!(teardown_started.await.unwrap(), surplus_workspace);
    let snapshot = tokio::time::timeout(Duration::from_secs(1), handle.snapshot())
        .await
        .expect("surplus teardown should not block pool state");
    assert_eq!(snapshot.ready, 1);
    assert_eq!(snapshot.teardowns, 1);

    let acquired = tokio::time::timeout(Duration::from_secs(1), handle.acquire())
        .await
        .expect("surplus teardown should not block a ready acquire")
        .unwrap();
    assert_eq!(acquired.id(), "ready-during-surplus-teardown");
    destroy_prepared_slot_async(acquired).await;
    assert_eq!(retained_dropped.await.unwrap(), retained_workspace);
    wait_for_snapshot(&handle, |snapshot| {
        snapshot.pending == 1 && snapshot.teardowns == 1
    })
    .await;

    let cleanup = tokio::spawn({
        let handle = handle.clone();
        async move { handle.cleanup().await }
    });
    controller
        .take_request()
        .send(Err(CowPoolError::CowFileCreation(
            "cleanup replacement".into(),
        )))
        .unwrap();
    release_teardown.send(()).unwrap();
    assert_eq!(surplus_dropped.await.unwrap(), surplus_workspace);
    cleanup.await.unwrap();
}

#[tokio::test]
async fn creation_failure_fails_one_waiter_and_retries_remaining_waiter() {
    let tmp = tempfile::tempdir().unwrap();
    let (controller, spawner) = ControlledSpawner::new();
    let pool = test_pool_with_spawner(test_config(tmp.path()), 0, 1, 4, Duration::ZERO, spawner);
    let handle = CowPoolHandle::new_for_test(pool);

    let first = tokio::spawn({
        let handle = handle.clone();
        async move { handle.acquire().await }
    });
    let second = tokio::spawn({
        let handle = handle.clone();
        async move { handle.acquire().await }
    });
    wait_for_snapshot(&handle, |snapshot| {
        snapshot.waiters == 2 && snapshot.pending == 1
    })
    .await;

    controller
        .take_request()
        .send(Err(CowPoolError::CowFileCreation("boom".into())))
        .unwrap();

    assert!(matches!(
        first.await.unwrap(),
        Err(CowPoolError::CowFileCreation(_))
    ));
    wait_for_snapshot(&handle, |snapshot| {
        snapshot.waiters == 1 && snapshot.pending == 1
    })
    .await;
    controller
        .take_request()
        .send(Ok(test_slot(tmp.path(), "second")))
        .unwrap();
    drop(second.await.unwrap().unwrap());
    handle.cleanup().await;
}

#[tokio::test]
async fn creation_failure_skips_cancelled_waiter() {
    let tmp = tempfile::tempdir().unwrap();
    let (controller, spawner) = ControlledSpawner::new();
    let pool = test_pool_with_spawner(test_config(tmp.path()), 0, 1, 4, Duration::ZERO, spawner);
    let handle = CowPoolHandle::new_for_test(pool);

    let cancelled = tokio::spawn({
        let handle = handle.clone();
        async move { handle.acquire().await }
    });
    let active = tokio::spawn({
        let handle = handle.clone();
        async move { handle.acquire().await }
    });
    wait_for_snapshot(&handle, |snapshot| {
        snapshot.waiters == 2 && snapshot.pending == 1
    })
    .await;
    cancelled.abort();
    assert!(cancelled.await.unwrap_err().is_cancelled());

    controller
        .take_request()
        .send(Err(CowPoolError::CowFileCreation("boom".into())))
        .unwrap();

    assert!(matches!(
        active.await.unwrap(),
        Err(CowPoolError::CowFileCreation(_))
    ));
    handle.cleanup().await;
}

#[tokio::test]
async fn single_demand_failure_backs_off_warm_retry_until_next_demand() {
    let tmp = tempfile::tempdir().unwrap();
    let (controller, spawner) = ControlledSpawner::new();
    let pool = test_pool_with_spawner(
        test_config(tmp.path()),
        1,
        1,
        4,
        Duration::from_secs(60),
        spawner,
    );
    let handle = CowPoolHandle::new_for_test(pool);

    let first = tokio::spawn({
        let handle = handle.clone();
        async move { handle.acquire().await }
    });
    wait_for_snapshot(&handle, |snapshot| snapshot.pending == 1).await;
    controller
        .take_request()
        .send(Err(CowPoolError::CowFileCreation("demand failed".into())))
        .unwrap();
    assert!(matches!(
        first.await.unwrap(),
        Err(CowPoolError::CowFileCreation(_))
    ));
    wait_for_snapshot(&handle, |snapshot| {
        snapshot.pending == 0 && snapshot.warm_retry_scheduled
    })
    .await;
    assert_eq!(controller.request_count(), 0);

    let second = tokio::spawn({
        let handle = handle.clone();
        async move { handle.acquire().await }
    });
    wait_for_snapshot(&handle, |snapshot| snapshot.pending == 1).await;
    controller
        .take_request()
        .send(Ok(test_slot(tmp.path(), "demand-success")))
        .unwrap();
    drop(second.await.unwrap().unwrap());
    wait_for_snapshot(&handle, |snapshot| {
        snapshot.pending == 1 && !snapshot.warm_retry_scheduled
    })
    .await;
    controller
        .take_request()
        .send(Ok(test_slot(tmp.path(), "warm-after-success")))
        .unwrap();
    wait_for_snapshot(&handle, |snapshot| {
        snapshot.pending == 0 && snapshot.ready == 1
    })
    .await;
    handle.cleanup().await;
}

#[tokio::test(start_paused = true)]
async fn warm_replenishment_failure_uses_backoff() {
    let tmp = tempfile::tempdir().unwrap();
    let (controller, spawner) = ControlledSpawner::new();
    let pool = test_pool_with_spawner(
        test_config(tmp.path()),
        1,
        1,
        4,
        Duration::from_secs(10),
        spawner,
    );
    let handle = CowPoolHandle::new_for_test(pool);

    let warmup = tokio::spawn({
        let handle = handle.clone();
        async move { handle.warmup().await }
    });
    wait_for_snapshot(&handle, |snapshot| snapshot.pending == 1).await;
    controller
        .take_request()
        .send(Err(CowPoolError::CowFileCreation("missing golden".into())))
        .unwrap();
    warmup.await.unwrap();
    wait_for_snapshot(&handle, |snapshot| {
        snapshot.pending == 0 && snapshot.warm_retry_scheduled
    })
    .await;
    assert_eq!(controller.request_count(), 0);

    tokio::time::advance(Duration::from_secs(10)).await;
    wait_for_snapshot(&handle, |snapshot| snapshot.pending == 1).await;
    controller
        .take_request()
        .send(Err(CowPoolError::CowFileCreation("still missing".into())))
        .unwrap();
    wait_for_snapshot(&handle, |snapshot| snapshot.pending == 0).await;
    handle.cleanup().await;
}

#[tokio::test(start_paused = true)]
async fn due_warm_retry_runs_before_snapshot_command() {
    let tmp = tempfile::tempdir().unwrap();
    let (controller, spawner) = ControlledSpawner::new();
    let pool = test_pool_with_spawner(
        test_config(tmp.path()),
        1,
        1,
        4,
        Duration::from_secs(10),
        spawner,
    );
    let handle = CowPoolHandle::new_for_test(pool);

    let warmup = tokio::spawn({
        let handle = handle.clone();
        async move { handle.warmup().await }
    });
    wait_for_snapshot(&handle, |snapshot| snapshot.pending == 1).await;
    controller
        .take_request()
        .send(Err(CowPoolError::CowFileCreation("missing golden".into())))
        .unwrap();
    warmup.await.unwrap();
    wait_for_snapshot(&handle, |snapshot| {
        snapshot.pending == 0 && snapshot.warm_retry_scheduled
    })
    .await;

    tokio::time::advance(Duration::from_secs(10)).await;

    let snapshot = handle.snapshot().await;
    assert_eq!(snapshot.pending, 1);
    assert!(!snapshot.warm_retry_scheduled);

    controller
        .take_request()
        .send(Ok(test_slot(tmp.path(), "retry-before-snapshot")))
        .unwrap();
    wait_for_snapshot(&handle, |snapshot| {
        snapshot.pending == 0 && snapshot.ready == 1
    })
    .await;
    handle.cleanup().await;
}

#[tokio::test(start_paused = true)]
async fn cleanup_cancels_scheduled_warm_retry() {
    let tmp = tempfile::tempdir().unwrap();
    let (controller, spawner) = ControlledSpawner::new();
    let pool = test_pool_with_spawner(
        test_config(tmp.path()),
        1,
        1,
        4,
        Duration::from_secs(10),
        spawner,
    );
    let handle = CowPoolHandle::new_for_test(pool);

    let warmup = tokio::spawn({
        let handle = handle.clone();
        async move { handle.warmup().await }
    });
    wait_for_snapshot(&handle, |snapshot| snapshot.pending == 1).await;
    controller
        .take_request()
        .send(Err(CowPoolError::CowFileCreation("missing golden".into())))
        .unwrap();
    warmup.await.unwrap();
    wait_for_snapshot(&handle, |snapshot| {
        snapshot.pending == 0 && snapshot.warm_retry_scheduled
    })
    .await;

    handle.cleanup().await;
    tokio::time::advance(Duration::from_secs(10)).await;

    assert_eq!(controller.request_count(), 0);
    assert!(matches!(
        handle.acquire().await,
        Err(CowPoolError::ActorStopped | CowPoolError::NotActive)
    ));
}

#[tokio::test]
async fn cleanup_waits_for_ready_slot_teardown() {
    let tmp = tempfile::tempdir().unwrap();
    let (controller, spawner) = ControlledSpawner::new();
    let pool = test_pool_with_spawner(test_config(tmp.path()), 1, 1, 4, Duration::ZERO, spawner);
    let handle = CowPoolHandle::new_for_test(pool);

    let warmup = tokio::spawn({
        let handle = handle.clone();
        async move { handle.warmup().await }
    });
    wait_for_snapshot(&handle, |snapshot| snapshot.pending == 1).await;

    let (slot, teardown_started, release_teardown, dropped) =
        test_slot_with_teardown_gate(tmp.path(), "ready-cleanup-waits");
    let workspace = slot.workspace().to_owned();
    controller.take_request().send(Ok(slot)).unwrap();
    warmup.await.unwrap();
    assert!(workspace.exists());

    let cleanup = tokio::spawn({
        let handle = handle.clone();
        async move { handle.cleanup().await }
    });
    assert_eq!(teardown_started.await.unwrap(), workspace);
    assert!(workspace.exists());
    assert!(!cleanup.is_finished());

    release_teardown.send(()).unwrap();
    cleanup.await.unwrap();
    assert_eq!(dropped.await.unwrap(), workspace);
    assert!(!workspace.exists());
}

#[tokio::test]
async fn cleanup_tears_down_ready_and_late_slots_concurrently() {
    let tmp = tempfile::tempdir().unwrap();
    let (controller, spawner) = ControlledSpawner::new();
    let pool = test_pool_with_spawner(test_config(tmp.path()), 3, 3, 4, Duration::ZERO, spawner);
    let handle = CowPoolHandle::new_for_test(pool);

    let warmup = tokio::spawn({
        let handle = handle.clone();
        async move { handle.warmup().await }
    });
    wait_for_snapshot(&handle, |snapshot| snapshot.pending == 3).await;

    let mut slots = Vec::new();
    for index in 0..2 {
        let (slot, started, release, dropped) =
            test_slot_with_teardown_gate(tmp.path(), &format!("concurrent-cleanup-{index}"));
        slots.push((slot.workspace().to_owned(), started, release, dropped));
        controller.take_request().send(Ok(slot)).unwrap();
    }
    wait_for_snapshot(&handle, |snapshot| {
        snapshot.ready == 2 && snapshot.pending == 1
    })
    .await;

    let cleanup = tokio::spawn({
        let handle = handle.clone();
        async move { handle.cleanup().await }
    });

    for (workspace, started, _, _) in &mut slots {
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(1), started)
                .await
                .expect("ready slot teardown should start without waiting for another slot")
                .unwrap(),
            workspace.clone()
        );
    }

    let (late_slot, late_started, late_release, late_dropped) =
        test_slot_with_teardown_gate(tmp.path(), "concurrent-cleanup-late");
    let late_workspace = late_slot.workspace().to_owned();
    controller.take_request().send(Ok(late_slot)).unwrap();
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(1), late_started)
            .await
            .expect("late slot teardown should start while ready slots are still tearing down")
            .unwrap(),
        late_workspace
    );

    for (_, _, release, _) in &slots {
        release.send(()).unwrap();
    }
    late_release.send(()).unwrap();
    cleanup.await.unwrap();
    warmup.await.unwrap();

    for (workspace, _, _, dropped) in slots {
        assert_eq!(dropped.await.unwrap(), workspace);
        assert!(!workspace.exists());
    }
    assert_eq!(late_dropped.await.unwrap(), late_workspace);
    assert!(!late_workspace.exists());
}

#[tokio::test]
async fn cleanup_rejects_waiters_and_drops_late_pending_slot() {
    let tmp = tempfile::tempdir().unwrap();
    let (controller, spawner) = ControlledSpawner::new();
    let pool = test_pool_with_spawner(test_config(tmp.path()), 0, 1, 4, Duration::ZERO, spawner);
    let handle = CowPoolHandle::new_for_test(pool);

    let acquire = tokio::spawn({
        let handle = handle.clone();
        async move { handle.acquire().await }
    });
    wait_for_snapshot(&handle, |snapshot| {
        snapshot.waiters == 1 && snapshot.pending == 1
    })
    .await;

    let cleanup = tokio::spawn({
        let handle = handle.clone();
        async move { handle.cleanup().await }
    });
    let result = acquire.await.unwrap();
    assert!(matches!(result, Err(CowPoolError::NotActive)));

    let (late_slot, teardown_started, release_teardown, dropped) =
        test_slot_with_teardown_gate(tmp.path(), "late");
    let late_workspace = late_slot.workspace().to_owned();
    controller.take_request().send(Ok(late_slot)).unwrap();
    assert_eq!(teardown_started.await.unwrap(), late_workspace);
    assert!(late_workspace.exists());
    assert!(!cleanup.is_finished());

    release_teardown.send(()).unwrap();
    cleanup.await.unwrap();
    assert_eq!(dropped.await.unwrap(), late_workspace);
    assert!(!late_workspace.exists());
    assert!(matches!(
        handle.acquire().await,
        Err(CowPoolError::ActorStopped | CowPoolError::NotActive)
    ));
}

#[tokio::test]
async fn cleanup_is_not_starved_by_queued_acquires() {
    let tmp = tempfile::tempdir().unwrap();
    let (controller, spawner) = ControlledSpawner::new();
    let pool = test_pool_with_spawner(test_config(tmp.path()), 0, 1, 4, Duration::ZERO, spawner);
    let handle = CowPoolHandle::new_for_test(pool);

    let mut acquires = Vec::new();
    for _ in 0..20 {
        let handle = handle.clone();
        acquires.push(tokio::spawn(async move { handle.acquire().await }));
    }
    wait_for_snapshot(&handle, |snapshot| snapshot.pending == 1).await;

    let cleanup = tokio::spawn({
        let handle = handle.clone();
        async move { handle.cleanup().await }
    });
    controller
        .take_request()
        .send(Ok(test_slot(tmp.path(), "cleanup")))
        .unwrap();
    cleanup.await.unwrap();

    for acquire in acquires {
        match acquire.await.unwrap() {
            Err(CowPoolError::NotActive | CowPoolError::ActorStopped) => {}
            other => panic!("unexpected acquire result after cleanup: {other:?}"),
        }
    }
}

#[tokio::test]
async fn dropping_handle_cleans_ready_slots() {
    let tmp = tempfile::tempdir().unwrap();
    let (controller, spawner) = ControlledSpawner::new();
    let pool = test_pool_with_spawner(test_config(tmp.path()), 1, 1, 4, Duration::ZERO, spawner);
    let handle = CowPoolHandle::new_for_test(pool);

    let warmup = tokio::spawn({
        let handle = handle.clone();
        async move { handle.warmup().await }
    });
    wait_for_snapshot(&handle, |snapshot| snapshot.pending == 1).await;

    let (slot, dropped) = test_slot_with_drop_notify(tmp.path(), "ready-drop");
    let workspace = slot.workspace().to_owned();
    controller.take_request().send(Ok(slot)).unwrap();
    warmup.await.unwrap();
    assert!(workspace.exists());

    drop(handle);

    assert_eq!(dropped.await.unwrap(), workspace);
    assert!(!workspace.exists());
}

#[tokio::test]
async fn dropping_handle_drains_pending_slot_creation() {
    let tmp = tempfile::tempdir().unwrap();
    let (controller, spawner) = ControlledSpawner::new();
    let pool = test_pool_with_spawner(test_config(tmp.path()), 0, 1, 4, Duration::ZERO, spawner);
    let handle = CowPoolHandle::new_for_test(pool);

    let acquire = tokio::spawn({
        let handle = handle.clone();
        async move { handle.acquire().await }
    });
    wait_for_snapshot(&handle, |snapshot| {
        snapshot.waiters == 1 && snapshot.pending == 1
    })
    .await;
    acquire.abort();
    assert!(acquire.await.unwrap_err().is_cancelled());

    let (slot, dropped) = test_slot_with_drop_notify(tmp.path(), "pending-drop");
    let workspace = slot.workspace().to_owned();
    drop(handle);
    controller.take_request().send(Ok(slot)).unwrap();

    assert_eq!(dropped.await.unwrap(), workspace);
    assert!(!workspace.exists());
}

#[tokio::test]
async fn concurrent_cleanup_callers_complete_after_pending_slot_drains() {
    let tmp = tempfile::tempdir().unwrap();
    let (controller, spawner) = ControlledSpawner::new();
    let pool = test_pool_with_spawner(test_config(tmp.path()), 0, 1, 4, Duration::ZERO, spawner);
    let handle = CowPoolHandle::new_for_test(pool);

    let acquire = tokio::spawn({
        let handle = handle.clone();
        async move { handle.acquire().await }
    });
    wait_for_snapshot(&handle, |snapshot| {
        snapshot.waiters == 1 && snapshot.pending == 1
    })
    .await;

    let cleanup_one = tokio::spawn({
        let handle = handle.clone();
        async move { handle.cleanup().await }
    });
    let cleanup_two = tokio::spawn({
        let handle = handle.clone();
        async move { handle.cleanup().await }
    });

    let (slot, dropped) = test_slot_with_drop_notify(tmp.path(), "concurrent-cleanup");
    let workspace = slot.workspace().to_owned();
    controller.take_request().send(Ok(slot)).unwrap();

    cleanup_one.await.unwrap();
    cleanup_two.await.unwrap();
    assert_eq!(dropped.await.unwrap(), workspace);
    assert!(!workspace.exists());
    assert!(matches!(
        acquire.await.unwrap(),
        Err(CowPoolError::NotActive | CowPoolError::ActorStopped)
    ));
}

#[tokio::test]
async fn cancelled_cleanup_waiter_does_not_cancel_actor_cleanup() {
    let tmp = tempfile::tempdir().unwrap();
    let (controller, spawner) = ControlledSpawner::new();
    let pool = test_pool_with_spawner(test_config(tmp.path()), 0, 1, 4, Duration::ZERO, spawner);
    let handle = CowPoolHandle::new_for_test(pool);

    let acquire = tokio::spawn({
        let handle = handle.clone();
        async move { handle.acquire().await }
    });
    wait_for_snapshot(&handle, |snapshot| {
        snapshot.waiters == 1 && snapshot.pending == 1
    })
    .await;

    let cleanup_waiter = tokio::spawn({
        let handle = handle.clone();
        async move { handle.cleanup().await }
    });
    assert!(matches!(
        acquire.await.unwrap(),
        Err(CowPoolError::NotActive)
    ));
    cleanup_waiter.abort();
    assert!(cleanup_waiter.await.unwrap_err().is_cancelled());

    let (slot, dropped) = test_slot_with_drop_notify(tmp.path(), "cancelled-cleanup");
    let workspace = slot.workspace().to_owned();
    controller.take_request().send(Ok(slot)).unwrap();

    assert_eq!(dropped.await.unwrap(), workspace);
    assert!(!workspace.exists());
    assert!(matches!(
        handle.acquire().await,
        Err(CowPoolError::ActorStopped | CowPoolError::NotActive)
    ));
}

#[tokio::test]
async fn cancelled_warmup_waiter_keeps_pending_slot_for_cleanup() {
    let tmp = tempfile::tempdir().unwrap();
    let (controller, spawner) = ControlledSpawner::new();
    let pool = test_pool_with_spawner(test_config(tmp.path()), 1, 1, 4, Duration::ZERO, spawner);
    let handle = CowPoolHandle::new_for_test(pool);

    let warmup = tokio::spawn({
        let handle = handle.clone();
        async move { handle.warmup().await }
    });
    wait_for_snapshot(&handle, |snapshot| snapshot.pending == 1).await;
    warmup.abort();
    assert!(warmup.await.unwrap_err().is_cancelled());

    let cleanup = tokio::spawn({
        let handle = handle.clone();
        async move { handle.cleanup().await }
    });
    let (slot, dropped) = test_slot_with_drop_notify(tmp.path(), "cancelled-warmup");
    let workspace = slot.workspace().to_owned();
    controller.take_request().send(Ok(slot)).unwrap();

    cleanup.await.unwrap();
    assert_eq!(dropped.await.unwrap(), workspace);
    assert!(!workspace.exists());
    assert!(matches!(
        handle.acquire().await,
        Err(CowPoolError::ActorStopped | CowPoolError::NotActive)
    ));
}

#[tokio::test]
async fn slot_limit_enforced_under_concurrent_acquire() {
    let tmp = tempfile::tempdir().unwrap();
    let (controller, spawner) = ControlledSpawner::new();
    let pool = test_pool_with_spawner(test_config(tmp.path()), 0, 4, 2, Duration::ZERO, spawner);
    let handle = CowPoolHandle::new_for_test(pool);

    let mut acquires = Vec::new();
    for _ in 0..4 {
        let handle = handle.clone();
        acquires.push(tokio::spawn(async move { handle.acquire().await }));
    }

    wait_for_snapshot(&handle, |snapshot| {
        snapshot.waiters == 4 && snapshot.pending == 2 && snapshot.pipeline_slots == 2
    })
    .await;
    assert_eq!(controller.request_count(), 2);

    for i in 0..2 {
        controller
            .take_request()
            .send(Ok(test_slot(tmp.path(), &format!("limited-{i}"))))
            .unwrap();
    }
    wait_for_snapshot(&handle, |snapshot| snapshot.pending == 2).await;
    for i in 2..4 {
        controller
            .take_request()
            .send(Ok(test_slot(tmp.path(), &format!("limited-{i}"))))
            .unwrap();
    }
    for acquire in acquires {
        drop(acquire.await.unwrap().unwrap());
    }
    handle.cleanup().await;
}

#[tokio::test]
async fn zero_slot_limit_fails_all_waiters_without_hanging() {
    let tmp = tempfile::tempdir().unwrap();
    let (_controller, spawner) = ControlledSpawner::new();
    let pool = test_pool_with_spawner(test_config(tmp.path()), 0, 1, 0, Duration::ZERO, spawner);
    let handle = CowPoolHandle::new_for_test(pool);

    let first = tokio::spawn({
        let handle = handle.clone();
        async move { handle.acquire().await }
    });
    let second = tokio::spawn({
        let handle = handle.clone();
        async move { handle.acquire().await }
    });

    assert!(matches!(
        first.await.unwrap(),
        Err(CowPoolError::SlotLimitReached { max: 0 })
    ));
    assert!(matches!(
        second.await.unwrap(),
        Err(CowPoolError::SlotLimitReached { max: 0 })
    ));
    let snapshot = handle.snapshot().await;
    assert_eq!(snapshot.waiters, 0);
    assert_eq!(snapshot.pending, 0);
    handle.cleanup().await;
}

#[tokio::test]
async fn warmup_with_bad_config_does_not_panic() {
    let tmp = tempfile::tempdir().unwrap();
    let config = CowPoolConfig {
        workspaces_dir: tmp.path().to_owned(),
        base_size: 64 * 1024 * 1024,
        golden_cow: Some(PathBuf::from("/nonexistent/golden.img")),
        ..test_config(tmp.path())
    };
    let handle = CowPoolHandle::new(config);

    handle.warmup().await;

    let snapshot = handle.snapshot().await;
    assert_eq!(snapshot.ready, 0);
    assert_eq!(snapshot.pending, 0);
    assert_eq!(snapshot.pipeline_slots, 0);
    handle.cleanup().await;
}

#[tokio::test]
async fn create_slot_with_nonexistent_golden_cow_fails() {
    let tmp = tempfile::tempdir().unwrap();
    let config = CowFileConfig {
        workspaces_dir: tmp.path().to_owned(),
        base_size: 64 * 1024 * 1024,
        golden_cow: Some(PathBuf::from("/nonexistent/golden.img")),
    };
    let err = create_slot(&config).await.unwrap_err();
    assert!(matches!(err, CowPoolError::CowFileCreation(_)));
    assert!(
        err.to_string()
            .contains("command failed: cp --sparse=always --"),
        "expected bounded command failure, got {err}"
    );
    let entries: Vec<_> = std::fs::read_dir(tmp.path()).unwrap().collect();
    assert_eq!(entries.len(), 0);
}

#[tokio::test]
async fn create_slot_stalled_copy_times_out_and_removes_partial_workspace() {
    let tmp = tempfile::tempdir().unwrap();
    let workspaces = tmp.path().join("workspaces");
    let golden = tmp.path().join("stalled-golden.img");
    nix::unistd::mkfifo(
        &golden,
        nix::sys::stat::Mode::S_IRUSR | nix::sys::stat::Mode::S_IWUSR,
    )
    .unwrap();
    let config = CowFileConfig {
        workspaces_dir: workspaces.clone(),
        base_size: nbd_cow::BLOCK_SIZE as u64,
        golden_cow: Some(golden),
    };

    let err = create_slot_with_copy_timeout(&config, Duration::from_millis(50))
        .await
        .unwrap_err();

    assert!(
        err.to_string().contains("timed out after 50ms"),
        "expected copy timeout, got {err}"
    );
    let entries: Vec<_> = std::fs::read_dir(&workspaces).unwrap().collect();
    assert_eq!(entries.len(), 0);
}

#[tokio::test]
async fn cleanup_completes_after_stalled_copy_timeout() {
    let tmp = tempfile::tempdir().unwrap();
    let workspaces = tmp.path().join("workspaces");
    let golden = tmp.path().join("cleanup-stalled-golden.img");
    nix::unistd::mkfifo(
        &golden,
        nix::sys::stat::Mode::S_IRUSR | nix::sys::stat::Mode::S_IWUSR,
    )
    .unwrap();
    let file_config = CowFileConfig {
        workspaces_dir: workspaces.clone(),
        base_size: nbd_cow::BLOCK_SIZE as u64,
        golden_cow: Some(golden),
    };
    let spawner: SlotSpawner = Arc::new(move |_config| {
        let file_config = file_config.clone();
        tokio::spawn(async move {
            create_slot_with_copy_timeout(&file_config, Duration::from_millis(50))
                .await
                .map(PreparedCowSlot::new_for_test)
        })
    });
    let pool = test_pool_with_spawner(test_config(tmp.path()), 1, 1, 1, Duration::ZERO, spawner);
    let handle = CowPoolHandle::new_for_test(pool);
    let warmup = tokio::spawn({
        let handle = handle.clone();
        async move { handle.warmup().await }
    });
    wait_for_snapshot(&handle, |snapshot| snapshot.pending == 1).await;

    tokio::time::timeout(Duration::from_secs(2), handle.cleanup())
        .await
        .expect("cleanup remained blocked after copy timeout");
    warmup.await.unwrap();

    let entries: Vec<_> = std::fs::read_dir(&workspaces).unwrap().collect();
    assert_eq!(entries.len(), 0);
}

#[tokio::test]
async fn create_slot_with_bad_golden_bitmap_removes_partial_workspace() {
    let tmp = tempfile::tempdir().unwrap();
    let workspaces = tmp.path().join("workspaces");
    let golden = tmp.path().join("golden.img");
    std::fs::write(&golden, b"golden").unwrap();
    std::fs::create_dir(nbd_cow::cow::bitmap_path_for(&golden)).unwrap();

    let config = CowFileConfig {
        workspaces_dir: workspaces.clone(),
        base_size: 64 * 1024 * 1024,
        golden_cow: Some(golden),
    };
    let err = create_slot(&config).await.unwrap_err();
    assert!(
        matches!(err, CowPoolError::CowFileCreation(_)),
        "expected CowFileCreation, got {err}"
    );
    let entries: Vec<_> = std::fs::read_dir(&workspaces).unwrap().collect();
    assert_eq!(entries.len(), 0);
}

#[tokio::test]
async fn create_slot_with_golden_cow_without_bitmap_fails() {
    let tmp = tempfile::tempdir().unwrap();
    let workspaces = tmp.path().join("workspaces");
    let golden = tmp.path().join("golden.img");
    std::fs::write(&golden, b"golden").unwrap();

    let config = CowFileConfig {
        workspaces_dir: workspaces.clone(),
        base_size: 64 * 1024 * 1024,
        golden_cow: Some(golden),
    };
    let err = create_slot(&config).await.unwrap_err();
    assert!(
        matches!(err, CowPoolError::CowFileCreation(_)),
        "expected CowFileCreation, got {err}"
    );
    let entries: Vec<_> = std::fs::read_dir(&workspaces).unwrap().collect();
    assert_eq!(entries.len(), 0);
}

#[tokio::test]
async fn create_slot_with_invalid_golden_bitmap_removes_partial_workspace() {
    let tmp = tempfile::tempdir().unwrap();
    let workspaces = tmp.path().join("workspaces");
    let golden = tmp.path().join("golden.img");
    let golden_bitmap = nbd_cow::cow::bitmap_path_for(&golden);
    std::fs::write(&golden, b"golden").unwrap();
    std::fs::write(&golden_bitmap, b"invalid").unwrap();

    let config = CowFileConfig {
        workspaces_dir: workspaces.clone(),
        base_size: nbd_cow::BLOCK_SIZE as u64,
        golden_cow: Some(golden),
    };
    let err = create_slot(&config).await.unwrap_err();
    assert!(
        matches!(err, CowPoolError::CowFileCreation(_)),
        "expected CowFileCreation, got {err}"
    );
    let entries: Vec<_> = std::fs::read_dir(&workspaces).unwrap().collect();
    assert_eq!(entries.len(), 0);
}

#[tokio::test]
async fn create_slot_with_dirty_bitmap_beyond_golden_cow_removes_partial_workspace() {
    let tmp = tempfile::tempdir().unwrap();
    let workspaces = tmp.path().join("workspaces");
    let golden = tmp.path().join("golden.img");
    let golden_bitmap = nbd_cow::cow::bitmap_path_for(&golden);
    std::fs::write(&golden, b"").unwrap();
    write_bitmap_file(&golden_bitmap, 1, 1);

    let config = CowFileConfig {
        workspaces_dir: workspaces.clone(),
        base_size: nbd_cow::BLOCK_SIZE as u64,
        golden_cow: Some(golden),
    };
    let err = create_slot(&config).await.unwrap_err();
    assert!(
        matches!(err, CowPoolError::CowFileCreation(_)),
        "expected CowFileCreation, got {err}"
    );
    let entries: Vec<_> = std::fs::read_dir(&workspaces).unwrap().collect();
    assert_eq!(entries.len(), 0);
}

#[tokio::test]
async fn create_slot_with_non_utf8_golden_cow_copies_bitmap() {
    let tmp = tempfile::tempdir().unwrap();
    let workspaces = tmp.path().join("workspaces");
    let golden_name = OsString::from_vec(b"golden-\xff.img".to_vec());
    let golden = tmp.path().join(PathBuf::from(golden_name));
    let golden_bitmap = nbd_cow::cow::bitmap_path_for(&golden);
    std::fs::write(&golden, b"golden").unwrap();
    write_bitmap_file(&golden_bitmap, 1, 0);

    let config = CowFileConfig {
        workspaces_dir: workspaces,
        base_size: nbd_cow::BLOCK_SIZE as u64,
        golden_cow: Some(golden),
    };
    let slot = create_slot(&config).await.unwrap();
    let cow_bitmap = nbd_cow::cow::bitmap_path_for(&slot.cow_file());
    assert_eq!(
        std::fs::read(cow_bitmap).unwrap(),
        std::fs::read(golden_bitmap).unwrap()
    );
    destroy_slot_sync(slot);
}

#[tokio::test]
async fn create_slot_with_read_only_golden_cow_makes_workspace_cow_writable() {
    let tmp = tempfile::tempdir().unwrap();
    let workspaces = tmp.path().join("workspaces");
    let golden = tmp.path().join("golden.img");
    let golden_bitmap = nbd_cow::cow::bitmap_path_for(&golden);
    std::fs::write(&golden, b"golden").unwrap();
    write_bitmap_file(&golden_bitmap, 1, 0);
    std::fs::set_permissions(&golden, std::fs::Permissions::from_mode(0o444)).unwrap();

    let config = CowFileConfig {
        workspaces_dir: workspaces,
        base_size: nbd_cow::BLOCK_SIZE as u64,
        golden_cow: Some(golden),
    };
    let slot = create_slot(&config).await.unwrap();
    let cow_file = slot.cow_file();

    assert_eq!(
        std::fs::metadata(&cow_file).unwrap().permissions().mode() & 0o600,
        0o600
    );
    std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(cow_file)
        .unwrap();
    destroy_slot_sync(slot);
}

#[tokio::test]
async fn create_slot_fresh_mode_creates_cow_file() {
    let tmp = tempfile::tempdir().unwrap();
    let config = test_file_config(tmp.path());
    let slot = create_slot(&config).await.unwrap();
    let cow_file = slot.cow_file();
    assert!(cow_file.exists());
    let meta = std::fs::metadata(&cow_file).unwrap();
    assert_eq!(meta.len(), 64 * 1024 * 1024);
    destroy_slot_sync(slot);
}

#[tokio::test]
async fn create_slot_fresh_mode_rejects_empty_base_size() {
    let tmp = tempfile::tempdir().unwrap();
    let workspaces = tmp.path().join("workspaces");
    let config = CowFileConfig {
        workspaces_dir: workspaces.clone(),
        base_size: 0,
        golden_cow: None,
    };

    let err = create_slot(&config).await.unwrap_err();

    assert!(
        err.to_string().contains("base image size is empty"),
        "expected empty base size error, got {err}"
    );
    let entries: Vec<_> = std::fs::read_dir(&workspaces).unwrap().collect();
    assert_eq!(entries.len(), 0);
}

#[tokio::test]
async fn create_slot_fresh_mode_rejects_unaligned_base_size() {
    let tmp = tempfile::tempdir().unwrap();
    let workspaces = tmp.path().join("workspaces");
    let config = CowFileConfig {
        workspaces_dir: workspaces.clone(),
        base_size: nbd_cow::BLOCK_SIZE as u64 + 1,
        golden_cow: None,
    };

    let err = create_slot(&config).await.unwrap_err();

    assert!(
        err.to_string().contains("not a multiple"),
        "expected unaligned base size error, got {err}"
    );
    let entries: Vec<_> = std::fs::read_dir(&workspaces).unwrap().collect();
    assert_eq!(entries.len(), 0);
}

#[tokio::test]
async fn destroy_slot_sync_removes_workspace() {
    let tmp = tempfile::tempdir().unwrap();
    let config = test_file_config(tmp.path());
    let slot = create_slot(&config).await.unwrap();
    let ws = slot.workspace().to_owned();
    assert!(ws.exists());
    destroy_slot_sync(slot);
    assert!(!ws.exists());
}

#[tokio::test]
async fn prewarmed_slot_drop_fallback_removes_workspace() {
    let tmp = tempfile::tempdir().unwrap();
    let (slot, dropped) = raw_test_slot_with_drop_notify(tmp.path(), "drop-fallback");
    let workspace = slot.workspace().to_owned();

    assert!(workspace.exists());
    drop(slot);

    assert_eq!(dropped.await.unwrap(), workspace);
    assert!(!workspace.exists());
}

#[tokio::test]
async fn destroy_slot_async_starts_teardown_before_returned_future_is_polled() {
    let tmp = tempfile::tempdir().unwrap();
    let (slot, teardown_started, release_teardown, dropped) =
        raw_test_slot_with_teardown_gate(tmp.path(), "eager-teardown");
    let workspace = slot.workspace().to_owned();

    let teardown = destroy_slot_async(slot);
    let teardown_started = match tokio::time::timeout(Duration::from_secs(1), teardown_started)
        .await
    {
        Ok(Ok(workspace)) => workspace,
        result => {
            // A regressed waiter may own the slot, so disconnect its gate before dropping it.
            drop(release_teardown);
            drop(teardown);
            panic!(
                "file-only slot teardown should start before returned future is polled: {result:?}"
            );
        }
    };
    let workspace_existed_after_start = workspace.exists();

    drop(teardown);
    release_teardown
        .send(())
        .expect("file-only slot teardown should still be waiting on the gate");

    let dropped = tokio::time::timeout(Duration::from_secs(1), dropped)
        .await
        .expect("file-only slot teardown should finish after the gate is released")
        .expect("file-only slot teardown completion sender should remain available");

    assert_eq!(teardown_started, workspace);
    assert!(
        workspace_existed_after_start,
        "workspace should exist while file-only slot teardown waits on the gate"
    );
    assert_eq!(dropped, workspace);
    assert!(!workspace.exists());
}

#[test]
fn prepared_slot_checkout_moves_files_and_retargets_device() {
    let tmp = tempfile::tempdir().unwrap();
    let slot = raw_test_slot(tmp.path(), "prepared");
    let source_workspace = slot.workspace().to_owned();
    let source_cow = slot.cow_file();
    let source_bitmap = nbd_cow::cow::bitmap_path_for(&source_cow);
    std::fs::write(&source_bitmap, b"bitmap").unwrap();
    let slot = PreparedCowSlot::new_for_test(slot);
    let target_workspace = tmp.path().join("sandbox");
    std::fs::create_dir(&target_workspace).unwrap();

    let device = slot.checkout_to(&target_workspace).unwrap();

    let target_cow = target_workspace.join("cow.img");
    assert_eq!(device.cow_file(), target_cow);
    assert_eq!(std::fs::read(&target_cow).unwrap(), b"cow");
    assert_eq!(
        std::fs::read(nbd_cow::cow::bitmap_path_for(&target_cow)).unwrap(),
        b"bitmap"
    );
    assert!(!source_workspace.exists());
}

#[tokio::test]
async fn failed_prepared_checkout_can_be_cleaned_explicitly() {
    let tmp = tempfile::tempdir().unwrap();
    let (slot, dropped) = test_slot_with_drop_notify(tmp.path(), "checkout-failure");
    let workspace = slot.workspace().to_owned();
    let missing_target = tmp.path().join("missing").join("sandbox");

    let error = match slot.checkout_to(&missing_target) {
        Ok(_) => panic!("checkout unexpectedly succeeded"),
        Err(error) => error,
    };
    destroy_prepared_slot_async(error.into_slot()).await;

    assert_eq!(dropped.await.unwrap(), workspace);
    assert!(!workspace.exists());
}

#[tokio::test]
async fn partial_prepared_checkout_cleanup_leaves_target_for_transaction() {
    let tmp = tempfile::tempdir().unwrap();
    let (slot, dropped) = test_slot_with_drop_notify(tmp.path(), "partial-checkout");
    let source_workspace = slot.workspace().to_owned();
    let source_bitmap = nbd_cow::cow::bitmap_path_for(&source_workspace.join("cow.img"));
    std::fs::write(&source_bitmap, b"bitmap").unwrap();
    let target_workspace = tmp.path().join("sandbox");
    std::fs::create_dir(&target_workspace).unwrap();
    std::fs::create_dir(nbd_cow::cow::bitmap_path_for(
        &target_workspace.join("cow.img"),
    ))
    .unwrap();

    let error = match slot.checkout_to(&target_workspace) {
        Ok(_) => panic!("checkout unexpectedly succeeded"),
        Err(error) => error,
    };
    destroy_prepared_slot_async(error.into_slot()).await;

    assert_eq!(dropped.await.unwrap(), source_workspace);
    assert!(!source_workspace.exists());
    assert!(target_workspace.join("cow.img").exists());
}

#[tokio::test]
async fn checkout_failure_after_file_moves_leaves_target_for_transaction() {
    let tmp = tempfile::tempdir().unwrap();
    let (slot, dropped) = test_slot_with_drop_notify(tmp.path(), "source-cleanup-failure");
    let source_workspace = slot.workspace().to_owned();
    let source_cow = source_workspace.join("cow.img");
    let source_bitmap = nbd_cow::cow::bitmap_path_for(&source_cow);
    std::fs::write(&source_bitmap, b"bitmap").unwrap();
    std::fs::write(source_workspace.join("unexpected"), b"entry").unwrap();
    let target_workspace = tmp.path().join("sandbox");
    std::fs::create_dir(&target_workspace).unwrap();

    let error = match slot.checkout_to(&target_workspace) {
        Ok(_) => panic!("checkout unexpectedly succeeded"),
        Err(error) => error,
    };
    destroy_prepared_slot_async(error.into_slot()).await;

    let target_cow = target_workspace.join("cow.img");
    assert_eq!(dropped.await.unwrap(), source_workspace);
    assert!(!source_workspace.exists());
    assert_eq!(std::fs::read(&target_cow).unwrap(), b"cow");
    assert_eq!(
        std::fs::read(nbd_cow::cow::bitmap_path_for(&target_cow)).unwrap(),
        b"bitmap"
    );
}

#[tokio::test]
async fn prepared_slot_drop_starts_cleanup() {
    let tmp = tempfile::tempdir().unwrap();
    let (slot, dropped) = test_slot_with_drop_notify(tmp.path(), "prepared-drop");
    let workspace = slot.workspace().to_owned();

    drop(slot);

    assert_eq!(dropped.await.unwrap(), workspace);
    assert!(!workspace.exists());
}

#[test]
fn prepared_slot_drop_without_runtime_preserves_backing_workspace() {
    let tmp = tempfile::tempdir().unwrap();
    let (slot, mut dropped) = test_slot_with_drop_notify(tmp.path(), "drop-without-runtime");
    let workspace = slot.workspace().to_owned();

    drop(slot);

    assert!(matches!(
        dropped.try_recv(),
        Err(tokio::sync::oneshot::error::TryRecvError::Closed)
    ));
    assert!(workspace.exists());
}

#[tokio::test]
async fn destroy_prepared_slot_starts_teardown_before_waiter_is_polled() {
    let tmp = tempfile::tempdir().unwrap();
    let (slot, teardown_started, release_teardown, dropped) =
        test_slot_with_teardown_gate(tmp.path(), "prepared-eager-teardown");
    let workspace = slot.workspace().to_owned();

    let teardown = destroy_prepared_slot_async(slot);
    let teardown_started = match tokio::time::timeout(Duration::from_secs(1), teardown_started)
        .await
    {
        Ok(Ok(workspace)) => workspace,
        result => {
            // A regressed waiter may own the slot, so disconnect its gate before dropping it.
            drop(release_teardown);
            drop(teardown);
            panic!(
                "prepared slot teardown should start before returned waiter is polled: {result:?}"
            );
        }
    };
    let workspace_existed_after_start = workspace.exists();

    drop(teardown);
    release_teardown
        .send(())
        .expect("prepared slot teardown should still be waiting on the gate");

    let dropped = tokio::time::timeout(Duration::from_secs(1), dropped)
        .await
        .expect("prepared slot teardown should finish after the gate is released")
        .expect("prepared slot teardown completion sender should remain available");

    assert_eq!(teardown_started, workspace);
    assert!(
        workspace_existed_after_start,
        "workspace should exist while prepared slot teardown waits on the gate"
    );
    assert_eq!(dropped, workspace);
    assert!(!workspace.exists());
}
