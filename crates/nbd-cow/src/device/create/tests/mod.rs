use super::*;

#[test]
fn create_disconnect_status_maps_owned_results() {
    let disconnected: Result<OwnedDisconnectState> = Ok(OwnedDisconnectState::Disconnected);
    assert_eq!(
        CreateDisconnectStatus::from_owned_result(&disconnected),
        CreateDisconnectStatus::Disconnected
    );
    assert!(CreateDisconnectStatus::from_owned_result(&disconnected).is_clean());

    let foreign: Result<OwnedDisconnectState> = Ok(OwnedDisconnectState::Foreign);
    assert_eq!(
        CreateDisconnectStatus::from_owned_result(&foreign),
        CreateDisconnectStatus::Uncertain
    );
    assert!(!CreateDisconnectStatus::from_owned_result(&foreign).is_clean());

    let unknown: Result<OwnedDisconnectState> = Err(error::NbdCowError::Io(std::io::Error::other(
        "ownership unknown",
    )));
    assert_eq!(
        CreateDisconnectStatus::from_owned_result(&unknown),
        CreateDisconnectStatus::Uncertain
    );
    assert!(!CreateDisconnectStatus::from_owned_result(&unknown).is_clean());
}

#[tokio::test]
async fn abort_server_handles_waits_for_task_cleanup() {
    struct DropNotify(Option<tokio::sync::oneshot::Sender<()>>);

    impl Drop for DropNotify {
        fn drop(&mut self) {
            if let Some(tx) = self.0.take() {
                let _ = tx.send(());
            }
        }
    }

    let (dropped_tx, dropped_rx) = tokio::sync::oneshot::channel();
    let (started_tx, started_rx) = tokio::sync::oneshot::channel();
    let handle = tokio::spawn(async move {
        let _notify = DropNotify(Some(dropped_tx));
        let _ = started_tx.send(());
        std::future::pending::<()>().await;
    });

    started_rx.await.unwrap();
    abort_server_handles(vec![handle]).await;

    tokio::time::timeout(std::time::Duration::from_secs(1), dropped_rx)
        .await
        .unwrap()
        .unwrap();
}

#[tokio::test]
async fn create_attempt_guard_drop_aborts_dispatch_and_preserves_lease_cooldown() {
    struct DropNotify(Option<tokio::sync::oneshot::Sender<()>>);

    impl Drop for DropNotify {
        fn drop(&mut self) {
            if let Some(tx) = self.0.take() {
                let _ = tx.send(());
            }
        }
    }

    let lock_dir = tempfile::tempdir().expect("tempdir");
    let pool = pool::DevicePoolHandle::new_one_device_for_test(
        pool::DevicePoolConfig {
            cooldown: Duration::MAX,
        },
        lock_dir.path(),
    );
    let acquisition = tokio::time::timeout(Duration::from_secs(1), pool.acquire())
        .await
        .expect("pool acquire timed out")
        .expect("pool acquire failed");
    let (lease, _, _) = acquisition.into_parts();
    let device_index = lease.index();
    let snapshot = tokio::time::timeout(Duration::from_secs(1), pool.snapshot())
        .await
        .expect("initial pool snapshot timed out");
    assert!(snapshot.in_flight.contains(&device_index));
    assert!(snapshot.cooldown.is_empty());

    let mut guard = CreateAttemptGuard::new(pool.clone(), lease);
    let token = guard.shutdown_token();
    let (dropped_tx, dropped_rx) = tokio::sync::oneshot::channel();
    let (started_tx, started_rx) = tokio::sync::oneshot::channel();

    guard.push_server_handle(tokio::spawn(async move {
        let _notify = DropNotify(Some(dropped_tx));
        let _ = started_tx.send(());
        token.cancelled().await;
    }));

    tokio::time::timeout(Duration::from_secs(1), started_rx)
        .await
        .expect("dispatch task startup timed out")
        .expect("dispatch task exited before startup notification");
    drop(guard);

    tokio::time::timeout(Duration::from_secs(1), dropped_rx)
        .await
        .expect("dispatch task teardown timed out")
        .expect("dispatch task dropped without notification");
    tokio::time::timeout(Duration::from_secs(1), async {
        loop {
            let snapshot = pool.snapshot().await;
            if !snapshot.in_flight.contains(&device_index)
                && snapshot.cooldown == vec![device_index]
            {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("dropped create attempt did not reach cooldown");
    assert!(
        crate::device_lock::try_acquire_device_claim_in(device_index, lock_dir.path())
            .expect("lock probe")
            .is_none()
    );

    tokio::time::timeout(Duration::from_secs(1), pool.cleanup())
        .await
        .expect("pool cleanup timed out");
    assert!(
        crate::device_lock::try_acquire_device_claim_in(device_index, lock_dir.path())
            .expect("lock probe")
            .is_some()
    );
}
