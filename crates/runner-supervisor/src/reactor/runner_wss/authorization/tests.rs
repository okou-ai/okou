use super::*;

#[tokio::test(start_paused = true)]
async fn request_start_deadline_and_expired_grant_cannot_resurrect() {
    let authorities = Authorizations::default();
    let key = Key {
        run_id: RunId::new_v4(),
        authorization_epoch: Uuid::new_v4(),
    };
    let started = Instant::now();
    let lease = authorities.track(key, started + LEASE_WINDOW).unwrap();
    tokio::time::advance(std::time::Duration::from_secs(4)).await;
    // A response arriving late retains the original start, not arrival + 5s.
    authorities.apply(&[key], &[key], started + LEASE_WINDOW);
    tokio::time::advance(std::time::Duration::from_secs(1)).await;
    lease.closed().await;
    assert!(authorities.requested().is_empty());
    authorities.apply(&[key], &[key], Instant::now() + LEASE_WINDOW);
    lease.closed().await;
    assert!(authorities.requested().is_empty());
    assert!(authorities.track(key, started + LEASE_WINDOW).is_none());
    drop(lease);
    assert!(authorities.entries.lock().unwrap().is_empty());
}

#[tokio::test(start_paused = true)]
async fn denial_is_terminal_but_fresh_bootstrap_has_its_own_epoch() {
    let authorities = Authorizations::default();
    let old = Key {
        run_id: RunId::new_v4(),
        authorization_epoch: Uuid::new_v4(),
    };
    let lease = authorities
        .track(old, Instant::now() + LEASE_WINDOW)
        .unwrap();
    authorities.apply(&[old], &[], Instant::now() + LEASE_WINDOW);
    lease.closed().await;
    authorities.apply(&[old], &[old], Instant::now() + LEASE_WINDOW);
    lease.closed().await;
    let fresh = Key {
        authorization_epoch: Uuid::new_v4(),
        ..old
    };
    let _fresh = authorities
        .track(fresh, Instant::now() + LEASE_WINDOW)
        .unwrap();
    assert_eq!(authorities.requested(), vec![fresh]);
}

#[tokio::test(start_paused = true)]
async fn coalesces_shared_epochs_and_never_grants_unsolicited_or_duplicate_keys() {
    let authorities = Authorizations::default();
    let key = Key {
        run_id: RunId::new_v4(),
        authorization_epoch: Uuid::new_v4(),
    };
    let mut leases = Vec::new();
    for _ in 0..MAX_CONNECTIONS {
        leases.push(
            authorities
                .track(key, Instant::now() + LEASE_WINDOW)
                .unwrap(),
        );
    }
    assert_eq!(authorities.requested(), vec![key]);
    assert!(
        authorities
            .track(key, Instant::now() + LEASE_WINDOW)
            .is_none()
    );
    let started = Instant::now();
    tokio::time::advance(std::time::Duration::from_secs(4)).await;
    let wrong = Key {
        authorization_epoch: Uuid::new_v4(),
        ..key
    };
    authorities.apply(&[key], &[wrong], Instant::now() + LEASE_WINDOW);
    authorities.apply(&[key], &[key, key], Instant::now() + LEASE_WINDOW);
    tokio::time::advance(std::time::Duration::from_secs(1)).await;
    assert_eq!(Instant::now(), started + LEASE_WINDOW);
    leases[0].closed().await;
    assert!(authorities.requested().is_empty());
    drop(leases);
    assert!(authorities.entries.lock().unwrap().is_empty());
}

#[tokio::test(start_paused = true)]
async fn live_renewal_updates_waiter_without_restarting_request_window() {
    let authorities = Authorizations::default();
    let key = Key {
        run_id: RunId::new_v4(),
        authorization_epoch: Uuid::new_v4(),
    };
    let lease = authorities
        .track(key, Instant::now() + LEASE_WINDOW)
        .unwrap();
    let closed = lease.closed();
    tokio::pin!(closed);
    assert!(futures_util::poll!(closed.as_mut()).is_pending());
    tokio::time::advance(std::time::Duration::from_secs(2)).await;
    let started = Instant::now();
    authorities.apply(&[key], &[key], started + LEASE_WINDOW);
    assert!(futures_util::poll!(closed.as_mut()).is_pending());
    tokio::time::advance(std::time::Duration::from_secs(3)).await;
    assert!(futures_util::poll!(closed.as_mut()).is_pending());
    tokio::time::advance(std::time::Duration::from_secs(2)).await;
    closed.await;
    assert_eq!(Instant::now(), started + LEASE_WINDOW);
}

#[tokio::test(start_paused = true)]
async fn empty_listener_performs_no_reads_and_stop_joins_pending_control_io() {
    use std::sync::atomic::{AtomicUsize, Ordering};
    struct PendingReads {
        calls: AtomicUsize,
        active: Arc<AtomicUsize>,
    }
    struct ActiveRead(Arc<AtomicUsize>);
    impl Drop for ActiveRead {
        fn drop(&mut self) {
            self.0.fetch_sub(1, Ordering::SeqCst);
        }
    }
    #[async_trait::async_trait]
    impl TicketConsumer for PendingReads {
        async fn consume(&self, _: RunId, _: Uuid, _: &str, _: &str) -> Option<Uuid> {
            panic!("refresh cannot consume a ticket")
        }
        async fn authorized(&self, _: Uuid, _: &str, requested: &[Key]) -> Option<Vec<Key>> {
            assert_eq!(requested.len(), 1);
            self.calls.fetch_add(1, Ordering::SeqCst);
            assert_eq!(self.active.fetch_add(1, Ordering::SeqCst), 0);
            let _active = ActiveRead(Arc::clone(&self.active));
            std::future::pending().await
        }
    }
    let reader = Arc::new(PendingReads {
        calls: AtomicUsize::new(0),
        active: Arc::new(AtomicUsize::new(0)),
    });
    let authorities = Authorizations::default();
    let refresh = authorities.start(
        Uuid::new_v4(),
        Some("wss://runner.okou.ai:443".into()),
        reader.clone(),
    );
    tokio::task::yield_now().await;
    tokio::time::advance(std::time::Duration::from_secs(40)).await;
    tokio::task::yield_now().await;
    assert_eq!(reader.calls.load(Ordering::SeqCst), 0);
    let lease = authorities
        .track(
            Key {
                run_id: RunId::new_v4(),
                authorization_epoch: Uuid::new_v4(),
            },
            Instant::now() + LEASE_WINDOW,
        )
        .unwrap();
    tokio::time::advance(REFRESH_INTERVAL).await;
    tokio::task::yield_now().await;
    assert_eq!(reader.calls.load(Ordering::SeqCst), 1);
    assert_eq!(reader.active.load(Ordering::SeqCst), 1);
    refresh.stop().await;
    assert_eq!(reader.active.load(Ordering::SeqCst), 0);
    drop(lease);
    assert!(authorities.entries.lock().unwrap().is_empty());
}
