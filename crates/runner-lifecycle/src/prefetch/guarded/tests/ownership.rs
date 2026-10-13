use super::*;

#[tokio::test]
async fn cancelled_drain_waiter_cannot_forget_the_owned_pending_queue() {
    let fixture = Fixture::new(12).await;
    let candidate = fixture.file("snapshot", &vec![7; 4096], 1).await;
    let (mut tasks, mut latest) =
        MemoryPrefetchTasks::spawn_guarded([candidate], 1, fixture.config()).unwrap();
    {
        let first = tasks.drain();
        tokio::pin!(first);
        assert!(first.as_mut().now_or_never().is_none());
    }
    let cancel = tasks.cancel.clone();
    let second = tasks.drain();
    tokio::pin!(second);
    assert!(second.as_mut().now_or_never().is_none());
    cancel.cancel();
    tokio::time::timeout(WAIT, second).await.unwrap();
    let result = report(&mut latest, |r| r.finished).await;
    assert_eq!(result.accepted, 0);
    assert_eq!(
        fixture.operations.snapshot().unwrap().registered_operations,
        0
    );
    fixture.stop().await;
}

#[tokio::test]
async fn cancelled_read_is_retained_until_physical_io_and_fresh_settlement_finish() {
    let fixture = Fixture::new(48).await;
    let candidate = fixture.file("snapshot", &vec![7; 4096], 1).await;
    let gate = Arc::new(Gate::default());
    let (mut tasks, mut latest) = MemoryPrefetchTasks::spawn_guarded_with(
        [candidate],
        1,
        fixture.config(),
        gated_read(gate.clone(), false),
    )
    .unwrap();
    gate.entered().await;
    assert_eq!(fixture.operations.snapshot().unwrap().started, 1);
    // An independently fitting real owner progresses while optional IO is held.
    let marker = fixture.dir.path().join("fitting-owner");
    let mut request = fixture
        .operations
        .request(MemoryOperationPlan::HostIo { growth_bytes: MIB })
        .unwrap();
    request
        .try_grant()
        .await
        .unwrap()
        .spawn(move |mut operation| async move {
            tokio::fs::write(marker, b"foreground still fits")
                .await
                .unwrap();
            operation.complete_phase().await.unwrap();
        })
        .unwrap()
        .join()
        .await
        .unwrap();
    assert_eq!(
        tokio::fs::read(fixture.dir.path().join("fitting-owner"))
            .await
            .unwrap(),
        b"foreground still fits"
    );
    tasks.cancel();
    let drain = tasks.drain();
    tokio::pin!(drain);
    assert!(drain.as_mut().now_or_never().is_none());
    assert_eq!(
        fixture.operations.snapshot().unwrap().ordinary_growth_bytes,
        2 * MIB
    );
    gate.release();
    tokio::time::timeout(WAIT, drain).await.unwrap();
    let result = report(&mut latest, |r| r.finished).await;
    assert_eq!(
        (result.cancelled, result.completed, result.uncertain),
        (1, 0, 0)
    );
    assert_eq!(
        fixture.operations.snapshot().unwrap().registered_operations,
        0
    );
    fixture.stop().await;
}

#[tokio::test]
async fn outer_coordinator_loss_cannot_finish_drain_before_actual_reader() {
    let fixture = Fixture::new(48).await;
    let candidate = fixture.file("snapshot", &vec![7; 8192], 1).await;
    let gate = Arc::new(Gate::default());
    let (mut tasks, _) = MemoryPrefetchTasks::spawn_guarded_with(
        [candidate],
        1,
        fixture.config(),
        gated_read(gate.clone(), false),
    )
    .unwrap();
    gate.entered().await;
    tasks.handles[0].abort();
    let drain = tasks.drain();
    tokio::pin!(drain);
    assert!(drain.as_mut().now_or_never().is_none());
    assert_eq!(fixture.operations.snapshot().unwrap().started, 1);
    gate.release();
    tokio::time::timeout(WAIT, drain).await.unwrap();
    let settled = fixture.operations.close_and_wait().await.unwrap();
    assert_eq!(
        (settled.registered_operations, settled.tracked_tasks),
        (0, 0)
    );
    fixture.stop().await;
}

#[tokio::test]
async fn dropped_owner_and_reader_panic_preserve_physical_tracking_and_uncertainty() {
    for panic_after in [false, true] {
        let fixture = Fixture::new(48).await;
        let candidate = fixture.file("snapshot", &vec![7; 8192], 1).await;
        let gate = Arc::new(Gate::default());
        let (tasks, _) = MemoryPrefetchTasks::spawn_guarded_with(
            [candidate],
            1,
            fixture.config(),
            gated_read(gate.clone(), panic_after),
        )
        .unwrap();
        gate.entered().await;
        drop(tasks);
        let operations = fixture.operations.clone();
        let shutdown = operations.close_and_wait();
        tokio::pin!(shutdown);
        assert!(shutdown.as_mut().now_or_never().is_none());
        gate.release();
        let result = tokio::time::timeout(WAIT, shutdown).await.unwrap().unwrap();
        assert_eq!(result.tracked_tasks, 0);
        assert_eq!(result.uncertain, usize::from(panic_after));
        assert_eq!(
            result.ordinary_growth_bytes,
            if panic_after { 2 * MIB } else { 0 }
        );
        fixture.stop().await;
    }
}

#[tokio::test]
async fn critical_pressure_cancels_real_started_read_without_cancellation_credit() {
    let fixture = Fixture::new(48).await;
    let candidate = fixture.file("snapshot", &vec![7; 4096], 1).await;
    let gate = Arc::new(Gate::default());
    let (mut tasks, mut latest) = MemoryPrefetchTasks::spawn_guarded_with(
        [candidate],
        1,
        fixture.config(),
        gated_read(gate.clone(), false),
    )
    .unwrap();
    gate.entered().await;
    fixture.available(12).await;
    fixture.state(HostPressureState::Critical).await;
    assert_eq!(fixture.operations.snapshot().unwrap().started, 1);
    gate.release();
    tokio::time::timeout(WAIT, tasks.drain()).await.unwrap();
    let result = report(&mut latest, |r| r.finished).await;
    assert_eq!(
        (result.cancelled, result.read_bytes, result.uncertain),
        (1, 128, 0)
    );
    // Valid low occupancy settles actual completed IO, never predicted freed pages.
    assert_eq!(fixture.control.decision().available_bytes, Some(12 * MIB));
    fixture.stop().await;
}
