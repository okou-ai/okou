use super::*;

#[test]
fn tracked_indices_include_cooldown_and_in_flight() {
    let dir = tempfile::tempdir().expect("tempdir");
    let mut pool = test_pool(2, Duration::from_secs(60), dir.path(), always_free);
    pool.in_flight.insert(0);
    pool.release(lease(0, dir.path()));
    pool.in_flight.insert(1);

    let tracked = pool.tracked_indices();

    assert_eq!(tracked.len(), 2);
    assert!(tracked.contains(&0));
    assert!(tracked.contains(&1));
}

#[tokio::test]
async fn cooldown_timer_releases_expired_claim_without_waiter() {
    let dir = tempfile::tempdir().expect("tempdir");
    let handle = DevicePoolHandle::from_pool(test_pool_with_in_flight(3, dir.path()));

    handle.release_clean(lease(3, dir.path())).await;
    assert!(
        device_lock::try_acquire_device_claim_in(3, dir.path())
            .expect("lock probe")
            .is_none()
    );

    tokio::time::timeout(Duration::from_secs(1), async {
        loop {
            let snapshot = handle.snapshot().await;
            if snapshot.cooldown.is_empty()
                && device_lock::try_acquire_device_claim_in(3, dir.path())
                    .expect("lock probe")
                    .is_some()
            {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("cooldown timer did not release claim");
    handle.cleanup().await;
}

#[tokio::test]
async fn expired_cooldown_with_waiter_hands_off_same_claim() {
    let dir = tempfile::tempdir().expect("tempdir");
    let mut pool = test_pool(0, Duration::ZERO, dir.path(), always_free);
    pool.in_flight.insert(3);
    // Keep the acquire queued before release without exhausting the zero-device scan.
    let (pending, _complete_scan) = pending_controlled_scan();
    let handle = DevicePoolHandle::from_pool_with_pending(pool, pending);

    let acquire_task = tokio::spawn({
        let handle = handle.clone();
        async move { handle.acquire().await }
    });
    wait_for_scan_waiter(&handle).await;

    // Immediate expiry happens only after the waiter exists, even if release is delayed.
    tokio::time::timeout(
        Duration::from_secs(1),
        handle.release_clean(lease(3, dir.path())),
    )
    .await
    .expect("clean release timed out");

    let lease = tokio::time::timeout(Duration::from_secs(1), acquire_task)
        .await
        .expect("cooldown handoff timed out")
        .expect("acquire task panicked")
        .expect("acquire failed");
    assert_eq!(lease.index(), 3);
    assert_eq!(lease.source(), DeviceAcquireSource::CooledClaim);
    assert_eq!(lease.scan_duration(), None);
    tokio::time::timeout(Duration::from_secs(1), async {
        handle.discard(lease.into_lease()).await;
        handle.cleanup().await;
    })
    .await
    .expect("cooldown handoff cleanup timed out");
}

#[tokio::test]
async fn expired_cooldown_with_failed_recheck_drops_claim_and_scans() {
    let dir = tempfile::tempdir().expect("tempdir");
    let mut pool = test_pool(0, Duration::from_secs(60), dir.path(), never_free);
    pool.in_flight.insert(3);

    pool.release_claim(claim(3, dir.path()));
    let (respond_to, mut response) = oneshot::channel();
    pool.waiting_acquires.push_back(respond_to);
    pool.defer_scan_exhaustion();
    assert_eq!(pool.waiting_acquires.len(), 1);
    assert!(pool.deferred_scan_exhaustion);
    pool.ensure_waiting_progress(0);
    assert!(matches!(
        response.try_recv(),
        Err(oneshot::error::TryRecvError::Empty)
    ));

    pool.cooldown
        .front_mut()
        .expect("released claim should be cooling down")
        .expire_for_test();
    pool.process_expired_cooldown();
    pool.ensure_waiting_progress(0);

    let result = response
        .try_recv()
        .expect("waiter should receive scan failure");
    assert!(matches!(result, Err(NbdCowError::NoFreeDevice)));
    assert!(
        device_lock::try_acquire_device_claim_in(3, dir.path())
            .expect("lock probe")
            .is_some()
    );
}

#[tokio::test]
async fn overflowing_cooldown_keeps_actor_responsive_and_lock_held() {
    let dir = tempfile::tempdir().expect("tempdir");
    let mut pool = test_pool(8, Duration::MAX, dir.path(), always_free);
    pool.in_flight.insert(3);
    let handle = DevicePoolHandle::from_pool(pool);

    handle.release_clean(lease(3, dir.path())).await;
    let snapshot = tokio::time::timeout(Duration::from_secs(1), handle.snapshot())
        .await
        .expect("snapshot timed out after overflowing cooldown release");

    assert_eq!(snapshot.cooldown, vec![3]);
    assert!(
        device_lock::try_acquire_device_claim_in(3, dir.path())
            .expect("lock probe")
            .is_none()
    );

    tokio::time::timeout(Duration::from_secs(1), handle.cleanup())
        .await
        .expect("cleanup timed out after overflowing cooldown release");
    assert!(
        device_lock::try_acquire_device_claim_in(3, dir.path())
            .expect("lock probe")
            .is_some()
    );
}

#[tokio::test]
async fn non_expiring_cooldown_does_not_block_acquire_after_scan_failure() {
    let dir = tempfile::tempdir().expect("tempdir");
    let mut pool = test_pool(0, Duration::MAX, dir.path(), always_free);
    pool.in_flight.insert(3);
    let handle = DevicePoolHandle::from_pool(pool);

    handle.release_clean(lease(3, dir.path())).await;
    let result = tokio::time::timeout(Duration::from_secs(1), handle.acquire())
        .await
        .expect("acquire hung behind non-expiring cooldown");
    assert!(matches!(result, Err(NbdCowError::NoFreeDevice)));
    assert_eq!(handle.snapshot().await.cooldown, vec![3]);
    assert!(
        device_lock::try_acquire_device_claim_in(3, dir.path())
            .expect("lock probe")
            .is_none()
    );

    handle.cleanup().await;
    assert!(
        device_lock::try_acquire_device_claim_in(3, dir.path())
            .expect("lock probe")
            .is_some()
    );
}

#[tokio::test]
async fn non_expiring_cooldown_does_not_block_multiple_acquires() {
    let dir = tempfile::tempdir().expect("tempdir");
    let mut pool = test_pool(0, Duration::MAX, dir.path(), always_free);
    pool.in_flight.insert(3);
    let handle = DevicePoolHandle::from_pool(pool);

    handle.release_clean(lease(3, dir.path())).await;
    let first = tokio::spawn({
        let handle = handle.clone();
        async move { handle.acquire().await }
    });
    let second = tokio::spawn({
        let handle = handle.clone();
        async move { handle.acquire().await }
    });

    let (first_result, second_result) = tokio::time::timeout(Duration::from_secs(1), async {
        let first_result = first.await.expect("first acquire task panicked");
        let second_result = second.await.expect("second acquire task panicked");
        (first_result, second_result)
    })
    .await
    .expect("acquires hung behind non-expiring cooldown");

    assert!(matches!(first_result, Err(NbdCowError::NoFreeDevice)));
    assert!(matches!(second_result, Err(NbdCowError::NoFreeDevice)));
    let snapshot = handle.snapshot().await;
    assert_eq!(snapshot.cooldown, vec![3]);
    assert_eq!(snapshot.waiting_acquires, 0);

    handle.cleanup().await;
}
