use super::*;

#[tokio::test]
async fn accepted_replacement_survives_receiver_drop_and_joins_shutdown_through_held_io() {
    let fixture = BatchFixture::new().await;
    let mut old = fixture.park("thread:held-replacement", true).await;
    let (mut incoming, mut new) = fixture.incoming(&old.key).await;
    let kill = MockLifecycleGate::new();
    old.overrides.set_kill_lifecycle_gate(kill.clone());
    let result = fixture.insert(&mut incoming).await.unwrap();
    kill.wait_entered(1, WAIT).await.unwrap();
    assert_eq!(fixture.budget.allocated(), (4, 4096, 2));
    new.assert_active_bytes().await;
    drop(result);
    let shutdown = fixture.tracker.close_and_wait();
    tokio::pin!(shutdown);
    assert!(futures_util::poll!(&mut shutdown).is_pending());
    old.confirm_exit();
    kill.release_one();
    tokio::time::timeout(WAIT, shutdown).await.unwrap();
    old.assert_cached_bytes().await;
    assert_eq!(fixture.budget.allocated(), (2, 2048, 1));
    assert_eq!(
        fixture
            .operations
            .close_and_wait()
            .await
            .unwrap()
            .registered_operations,
        0
    );
    new.confirm_exit();
    fixture.recover().await;
}

struct PanickingSource;
impl MemoryObservationSource for PanickingSource {
    fn observe(&self) -> BoxFuture<'_, HostMemoryObservation> {
        Box::pin(async { panic!("synthetic lost observation producer") })
    }
}

#[tokio::test]
async fn lost_grant_producer_preserves_owners_and_accepted_provider_panic_keeps_coverage_uncertain()
{
    for accepted in [false, true] {
        let mut fixture = BatchFixture::new().await;
        let mut old = fixture.park("thread:panic-incoming", true).await;
        let (mut incoming, mut new) = fixture.incoming(&old.key).await;
        if accepted {
            old.overrides
                .push_kill_panic("synthetic retired provider panic");
            old.confirm_exit();
            let mut result = fixture.insert(&mut incoming).await.unwrap();
            let completion = complete(result.retirement.as_mut().unwrap()).await;
            assert_eq!(completion.outcome, DestroyOutcome::Uncertain);
            assert!(fixture.operations.snapshot().unwrap().uncertain > 0);
            drop(completion);
        } else {
            fixture.operations =
                HostMemoryOperations::new(policy(), Arc::new(PanickingSource)).unwrap();
            assert!(matches!(
                fixture.insert(&mut incoming).await,
                Err(MemoryOperationError::ProducerLost)
            ));
            old.assert_active_bytes().await;
            new.assert_active_bytes().await;
            assert_eq!(fixture.budget.allocated(), (4, 4096, 2));
            old.confirm_exit();
            new.confirm_exit();
            fixture.recover_incoming(incoming).await;
            fixture.recover().await;
            continue;
        }
        new.confirm_exit();
        fixture.recover().await;
    }
}

#[tokio::test]
async fn captured_batch_observation_is_fenced_after_concurrent_replacement_accounting() {
    let mut fixture = BatchFixture::new().await;
    let source = fixture.gate_observation(0);
    let mut old = fixture.park("thread:batch-collision-incoming", true).await;
    let (mut incoming, mut new) = fixture.incoming(&old.key).await;
    let mut batch = fixture.start(IdleRetirementBatchScope::All).await;
    source.wait_entered().await;
    old.confirm_exit();
    let mut replaced = fixture.insert(&mut incoming).await.unwrap();
    drop(complete(replaced.retirement.as_mut().unwrap()).await);
    source.release.notify_one();
    let report = tokio::time::timeout(WAIT, batch.join())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(report.completed, 0);
    assert_eq!(report.not_started.len(), 1);
    assert_eq!(
        report.not_started[0].error,
        MemoryOperationError::AccountingChanged
    );
    assert_eq!(
        fixture.pool.lock().await.status_snapshot().idle_sandboxes[0].sandbox_id,
        new.id
    );
    assert_eq!(new.overrides.kill_call_count(), 0);
    new.assert_active_bytes().await;
    old.assert_cached_bytes().await;
    new.confirm_exit();
    fixture.recover().await;
}
