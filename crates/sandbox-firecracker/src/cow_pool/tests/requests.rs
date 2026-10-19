use super::*;
use futures_util::FutureExt;
use tokio::sync::{Semaphore, mpsc};

enum WorkerDelay {
    Start,
    Completion,
}

async fn assert_burst_waits_for_requests(delay: WorkerDelay) {
    let tmp = tempfile::tempdir().unwrap();
    let (controller, controlled_spawner) = ControlledSpawner::new();
    let start = Arc::new(Semaphore::new(0));
    let finish = Arc::new(Semaphore::new(0));
    let (completed, mut completions) = mpsc::unbounded_channel();
    match delay {
        WorkerDelay::Start => finish.add_permits(5),
        WorkerDelay::Completion => start.add_permits(5),
    }
    let spawner: SlotSpawner = Arc::new({
        let start = Arc::clone(&start);
        let finish = Arc::clone(&finish);
        move |config| {
            let start = Arc::clone(&start);
            let finish = Arc::clone(&finish);
            let controlled_spawner = Arc::clone(&controlled_spawner);
            let completed = completed.clone();
            tokio::spawn(async move {
                start.acquire().await.unwrap().forget();
                let result = controlled_spawner(config).await.unwrap();
                completed.send(()).unwrap();
                finish.acquire().await.unwrap().forget();
                result
            })
        }
    });
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

    let already_completed = match delay {
        WorkerDelay::Start => 0,
        WorkerDelay::Completion => {
            controller.wait_for_requests(2).await;
            assert_eq!(controller.request_count(), 2);
            for index in 0..2 {
                controller
                    .take_request()
                    .await
                    .send(Ok(test_slot(tmp.path(), &format!("delayed-{index}"))))
                    .unwrap();
            }
            // Both results have been sent, but their workers cannot return them yet.
            for _ in 0..2 {
                completions.recv().await.unwrap();
            }
            2
        }
    };
    let snapshot = handle.snapshot().await;
    assert_eq!(snapshot.pending, 2);
    assert_eq!(snapshot.waiters, 5);
    assert_eq!(snapshot.pipeline_slots, 2);
    assert_eq!(controller.request_count(), 0);

    let request = controller.take_request();
    tokio::pin!(request);
    assert!(request.as_mut().now_or_never().is_none());
    match delay {
        WorkerDelay::Start => start.add_permits(5),
        WorkerDelay::Completion => finish.add_permits(5),
    }
    request
        .await
        .send(Ok(test_slot(
            tmp.path(),
            &format!("delayed-{already_completed}"),
        )))
        .unwrap();
    assert!(handle.snapshot().await.pending <= 2);

    for index in already_completed + 1..5 {
        controller
            .take_request()
            .await
            .send(Ok(test_slot(tmp.path(), &format!("delayed-{index}"))))
            .unwrap();
        assert!(handle.snapshot().await.pending <= 2);
    }
    let mut slot_ids = Vec::new();
    for acquire in acquires {
        let slot = acquire.await.unwrap().unwrap();
        slot_ids.push(slot.id().to_owned());
        drop(slot);
    }
    slot_ids.sort();
    assert_eq!(
        slot_ids,
        (0..5)
            .map(|index| format!("delayed-{index}"))
            .collect::<Vec<_>>()
    );
    let snapshot = handle.snapshot().await;
    assert_eq!(snapshot.ready, 0);
    assert_eq!(snapshot.pending, 0);
    assert_eq!(snapshot.teardowns, 0);
    assert_eq!(snapshot.waiters, 0);
    assert_eq!(snapshot.pipeline_slots, 0);
    assert_eq!(controller.request_count(), 0);
    handle.cleanup().await;
    assert!(matches!(
        handle.acquire().await,
        Err(CowPoolError::ActorStopped | CowPoolError::NotActive)
    ));
}

#[tokio::test]
async fn burst_waits_for_delayed_worker_start() {
    tokio::time::timeout(
        Duration::from_secs(5),
        assert_burst_waits_for_requests(WorkerDelay::Start),
    )
    .await
    .expect("burst did not drain after releasing worker starts");
}

#[tokio::test]
async fn burst_waits_for_delayed_completion_processing() {
    tokio::time::timeout(
        Duration::from_secs(5),
        assert_burst_waits_for_requests(WorkerDelay::Completion),
    )
    .await
    .expect("burst did not drain after releasing completed workers");
}
