use super::*;

fn key() -> Key {
    Key {
        run_id: RunId::new_v4(),
        digest: "1".repeat(64),
        org_id: "org".to_owned(),
        user_id: "user".to_owned(),
    }
}

#[tokio::test(start_paused = true)]
async fn request_start_deadline_and_expired_grant_cannot_resurrect() {
    let authorities = Authorizations::default();
    let key = key();
    let started = Instant::now();
    let lease = authorities
        .track(key.clone(), started + LEASE_WINDOW)
        .unwrap();
    tokio::time::advance(std::time::Duration::from_secs(4)).await;
    authorities.apply(
        std::slice::from_ref(&key),
        std::slice::from_ref(&key),
        started + LEASE_WINDOW,
    );
    tokio::time::advance(std::time::Duration::from_secs(1)).await;
    lease.closed().await;
    assert!(authorities.requested().is_empty());
    authorities.apply(
        std::slice::from_ref(&key),
        std::slice::from_ref(&key),
        Instant::now() + LEASE_WINDOW,
    );
    lease.closed().await;
    assert!(authorities.requested().is_empty());
    assert!(authorities.track(key, started + LEASE_WINDOW).is_none());
    drop(lease);
    assert!(authorities.entries.lock().unwrap().is_empty());
}

#[tokio::test(start_paused = true)]
async fn denial_is_terminal_but_fresh_bootstrap_has_its_own_ticket() {
    let authorities = Authorizations::default();
    let old = key();
    let lease = authorities
        .track(old.clone(), Instant::now() + LEASE_WINDOW)
        .unwrap();
    authorities.apply(
        std::slice::from_ref(&old),
        &[],
        Instant::now() + LEASE_WINDOW,
    );
    lease.closed().await;
    authorities.apply(
        std::slice::from_ref(&old),
        std::slice::from_ref(&old),
        Instant::now() + LEASE_WINDOW,
    );
    lease.closed().await;
    let fresh = Key {
        digest: "2".repeat(64),
        ..old
    };
    let _fresh = authorities
        .track(fresh.clone(), Instant::now() + LEASE_WINDOW)
        .unwrap();
    assert_eq!(authorities.requested(), vec![fresh]);
}

#[tokio::test(start_paused = true)]
async fn coalesces_exact_ticket_keys_and_rejects_unsolicited_or_duplicate_proofs() {
    let authorities = Authorizations::default();
    let key = key();
    let mut leases = Vec::new();
    for _ in 0..MAX_CONNECTIONS {
        leases.push(
            authorities
                .track(key.clone(), Instant::now() + LEASE_WINDOW)
                .unwrap(),
        );
    }
    assert_eq!(authorities.requested(), vec![key.clone()]);
    assert!(
        authorities
            .track(key.clone(), Instant::now() + LEASE_WINDOW)
            .is_none()
    );
    let started = Instant::now();
    tokio::time::advance(std::time::Duration::from_secs(4)).await;
    let wrong = Key {
        digest: "2".repeat(64),
        ..key.clone()
    };
    authorities.apply(
        std::slice::from_ref(&key),
        &[wrong],
        Instant::now() + LEASE_WINDOW,
    );
    authorities.apply(
        std::slice::from_ref(&key),
        &[key.clone(), key.clone()],
        Instant::now() + LEASE_WINDOW,
    );
    tokio::time::advance(std::time::Duration::from_secs(1)).await;
    assert_eq!(Instant::now(), started + LEASE_WINDOW);
    leases[0].closed().await;
    assert!(authorities.requested().is_empty());
    drop(leases);
    assert!(authorities.entries.lock().unwrap().is_empty());
}

#[tokio::test(start_paused = true)]
async fn distinct_sessions_on_one_run_have_independent_terminal_leases() {
    let authorities = Authorizations::default();
    let first = key();
    let second = Key {
        digest: "2".repeat(64),
        ..first.clone()
    };
    let _first = authorities
        .track(first.clone(), Instant::now() + LEASE_WINDOW)
        .unwrap();
    let second_lease = authorities
        .track(second.clone(), Instant::now() + LEASE_WINDOW)
        .unwrap();
    let requested = authorities.requested();
    assert_eq!(requested.len(), 2);
    authorities.apply(
        &requested,
        std::slice::from_ref(&first),
        Instant::now() + LEASE_WINDOW,
    );
    second_lease.closed().await;
    assert_eq!(authorities.requested(), vec![first]);
}

#[tokio::test(start_paused = true)]
async fn live_renewal_updates_waiter_without_restarting_request_window() {
    let authorities = Authorizations::default();
    let key = key();
    let lease = authorities
        .track(key.clone(), Instant::now() + LEASE_WINDOW)
        .unwrap();
    let closed = lease.closed();
    tokio::pin!(closed);
    assert!(futures_util::poll!(closed.as_mut()).is_pending());
    tokio::time::advance(std::time::Duration::from_secs(2)).await;
    let started = Instant::now();
    authorities.apply(
        std::slice::from_ref(&key),
        std::slice::from_ref(&key),
        started + LEASE_WINDOW,
    );
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
        async fn consume(&self, _: RunId, _: Uuid, _: &str, _: &str) -> Option<Key> {
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
        .track(key(), Instant::now() + LEASE_WINDOW)
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
