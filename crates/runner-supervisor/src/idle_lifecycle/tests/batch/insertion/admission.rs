use super::*;

#[tokio::test]
async fn pool_lifecycle_closing_during_grant_wait_refuses_both_owners_without_cleanup() {
    let mut fixture = BatchFixture::new().await;
    let source = fixture.gate_observation(0);
    let mut old = fixture.park("thread:gate-close-incoming", true).await;
    let (mut incoming, mut new) = fixture.incoming(&old.key).await;
    {
        let caller = fixture.insert(&mut incoming);
        tokio::pin!(caller);
        tokio::select! { () = source.wait_entered() => {}, _ = &mut caller => panic!("held grant finished") }
        fixture.pool.lock().await.parking_gate().close();
        source.release.notify_one();
        assert!(matches!(caller.await, Err(MemoryOperationError::Closed)));
    }
    assert_eq!(incoming.sandbox_id(), Some(new.id));
    assert_eq!(fixture.budget.allocated(), (4, 4096, 2));
    old.assert_active_bytes().await;
    new.assert_active_bytes().await;
    old.confirm_exit();
    new.confirm_exit();
    fixture.recover_incoming(incoming).await;
    fixture.recover().await;
}

#[tokio::test]
async fn denied_live_tail_or_missing_proof_preserves_both_home_owners_and_full_leases() {
    for (captured, available) in [(false, 64), (true, 9), (true, 10)] {
        let fixture = BatchFixture::new().await;
        let mut old = fixture.park("thread:refused-incoming", captured).await;
        let (mut incoming, mut new) = fixture.incoming(&old.key).await;
        tokio::fs::write(
            &fixture.meminfo,
            format!("MemAvailable: {} kB\n", available * 1024),
        )
        .await
        .unwrap();
        let revision = fixture.pool.lock().await.revision();
        let result = fixture.insert(&mut incoming).await;
        if captured {
            assert!(matches!(
                result,
                Err(MemoryOperationError::InsufficientHeadroom { .. })
            ));
        } else {
            assert!(matches!(result, Err(MemoryOperationError::MissingBacking)));
        }
        assert_eq!(fixture.pool.lock().await.revision(), revision);
        assert_eq!(incoming.sandbox_id(), Some(new.id));
        assert_eq!(fixture.budget.allocated(), (4, 4096, 2));
        assert_eq!(
            fixture.operations.snapshot().unwrap().registered_operations,
            0
        );
        old.assert_active_bytes().await;
        new.assert_active_bytes().await;
        assert_eq!(old.overrides.kill_call_count(), 0);
        assert_eq!(new.overrides.kill_call_count(), 0);
        old.confirm_exit();
        new.confirm_exit();
        fixture.recover_incoming(incoming).await;
        fixture.recover().await;
    }
}

#[tokio::test]
async fn cancelled_tail_grant_retains_original_pool_and_borrowed_incoming() {
    let mut fixture = BatchFixture::new().await;
    let source = fixture.gate_observation(1);
    let mut old = fixture.park("thread:cancel-incoming", true).await;
    let (mut incoming, mut new) = fixture.incoming(&old.key).await;
    let revision = fixture.pool.lock().await.revision();
    {
        let caller = fixture.insert(&mut incoming);
        tokio::pin!(caller);
        tokio::select! { () = source.wait_entered() => {}, _ = &mut caller => panic!("held grant finished") }
        assert_eq!(
            fixture.operations.snapshot().unwrap().cleanup_growth_bytes,
            8 * MIB
        );
        old.assert_active_bytes().await;
        new.assert_active_bytes().await;
    }
    assert_eq!(fixture.pool.lock().await.revision(), revision);
    assert_eq!(incoming.sandbox_id(), Some(new.id));
    assert_eq!(fixture.budget.allocated(), (4, 4096, 2));
    assert_eq!(
        fixture.operations.snapshot().unwrap().registered_operations,
        0
    );
    old.confirm_exit();
    new.confirm_exit();
    fixture.recover_incoming(incoming).await;
    fixture.recover().await;
}

#[tokio::test]
async fn reserve_or_repark_during_admission_invalidates_original_insertion() {
    for restored in [false, true] {
        let mut fixture = BatchFixture::new().await;
        let source = fixture.gate_observation(0);
        let mut old = fixture.park("thread:repark-incoming", true).await;
        let (mut incoming, mut new) = fixture.incoming(&old.key).await;
        let mut reservation;
        {
            let caller = fixture.insert(&mut incoming);
            tokio::pin!(caller);
            tokio::select! { () = source.wait_entered() => {}, _ = &mut caller => panic!("held grant finished") }
            reservation = Some(fixture.pool.lock().await.take_reserved(&old.key).unwrap());
            if restored {
                assert!(matches!(
                    fixture
                        .pool
                        .lock()
                        .await
                        .restore_reserved(reservation.take().unwrap()),
                    RestoreReservedIdleResult::Restored
                ));
            }
            source.release.notify_one();
            assert!(matches!(
                caller.await,
                Err(MemoryOperationError::ResourceChanged)
            ));
        }
        old.assert_active_bytes().await;
        new.assert_active_bytes().await;
        assert_eq!(incoming.sandbox_id(), Some(new.id));
        assert_eq!(old.overrides.kill_call_count(), 0);
        if let Some(reservation) = reservation {
            assert!(matches!(
                fixture.pool.lock().await.restore_reserved(reservation),
                RestoreReservedIdleResult::Restored
            ));
        }
        old.confirm_exit();
        new.confirm_exit();
        fixture.recover_incoming(incoming).await;
        fixture.recover().await;
    }
}

#[tokio::test]
async fn tracker_or_memory_authority_closing_during_wait_preserves_both_resources() {
    for close_tracker in [false, true] {
        let mut fixture = BatchFixture::new().await;
        let source = fixture.gate_observation(0);
        let mut old = fixture.park("thread:closed-incoming", true).await;
        let (mut incoming, mut new) = fixture.incoming(&old.key).await;
        {
            let caller = fixture.insert(&mut incoming);
            tokio::pin!(caller);
            tokio::select! { () = source.wait_entered() => {}, _ = &mut caller => panic!("held grant finished") }
            if close_tracker {
                fixture.tracker.close_and_wait().await;
            } else {
                fixture.operations.close_and_wait().await.unwrap();
            }
            source.release.notify_one();
            assert!(matches!(caller.await, Err(MemoryOperationError::Closed)));
        }
        assert_eq!(
            fixture.pool.lock().await.status_snapshot().idle_sandboxes[0].sandbox_id,
            old.id
        );
        assert_eq!(incoming.sandbox_id(), Some(new.id));
        old.assert_active_bytes().await;
        new.assert_active_bytes().await;
        old.confirm_exit();
        new.confirm_exit();
        fixture.recover_incoming(incoming).await;
        fixture.recover().await;
    }
}
