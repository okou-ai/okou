use super::*;
use std::collections::VecDeque;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

const TEST_SYNC_TIMEOUT: Duration = Duration::from_secs(5);

async fn wait_for_sync<T>(phase: &'static str, future: impl Future<Output = T>) -> T {
    match tokio::time::timeout(TEST_SYNC_TIMEOUT, future).await {
        Ok(value) => value,
        Err(_) => panic!("test synchronization timed out waiting for {phase}"),
    }
}

async fn wait_for_pool_index_reuse(locks: &LockPaths, expected: u32) -> PoolIndexLock {
    wait_for_sync("pool index to become reusable", async {
        loop {
            let (index, lock) = acquire_pool_lock(locks).unwrap();
            if index == expected {
                return lock;
            }
            drop(lock);
            // Close-only flocks can briefly survive in unrelated fork/exec children.
            tokio::task::yield_now().await;
        }
    })
    .await
}

async fn blocking_plain_creation(
    name: &'static str,
    entered: Arc<tokio::sync::Notify>,
    release: Arc<tokio::sync::Notify>,
) -> Result<NetnsInfo> {
    entered.notify_one();
    release.notified().await;
    Ok(test_info(name))
}

fn test_info(name: &str) -> NetnsInfo {
    NetnsInfo::new(name.into(), "test-ve".into(), "10.200.0.2".into())
}

fn probe_for_test<F, Fut>(probe: F) -> DnsReadinessProbe
where
    F: Fn(String) -> Fut + Send + Sync + 'static,
    Fut: Future<Output = std::result::Result<u16, DnsReadinessError>> + Send + 'static,
{
    Arc::new(move |namespace| Box::pin(probe(namespace)))
}

fn dns_pending_state(names: &[&str], ops: NetnsLifecycleOps) -> NetnsPoolState {
    let mut state = NetnsPoolState::inactive_for_test();
    state.active = true;
    state.proxy_port = Some(8080);
    state.dns_port = Some(5353);
    state.dns_readiness_state = DnsReadinessState::Pending;
    state.next_ns_index = MAX_NAMESPACES;
    state.ops = ops;
    state.proxy_queue = names.iter().map(|name| test_info(name)).collect();
    state
}

struct CountedLifecycle {
    ops: NetnsLifecycleOps,
    flush_count: Arc<AtomicUsize>,
    delete_count: Arc<AtomicUsize>,
}

struct BlockingFlushLifecycle {
    ops: NetnsLifecycleOps,
    entered: Arc<tokio::sync::Notify>,
    release: Arc<tokio::sync::Notify>,
}

struct BlockingFlushWithDeleteLifecycle {
    ops: NetnsLifecycleOps,
    entered: Arc<tokio::sync::Notify>,
    release: Arc<tokio::sync::Notify>,
    delete_count: Arc<AtomicUsize>,
}

struct FirstFlushBlocksLifecycle {
    ops: NetnsLifecycleOps,
    entered: Arc<tokio::sync::Notify>,
    release: Arc<tokio::sync::Notify>,
    flush_count: Arc<AtomicUsize>,
    delete_count: Arc<AtomicUsize>,
}

struct BlockingDeleteLifecycle {
    ops: NetnsLifecycleOps,
    entered: Arc<tokio::sync::Notify>,
    release: Arc<tokio::sync::Notify>,
    delete_count: Arc<AtomicUsize>,
}

struct FirstDeleteBlocksLifecycle {
    ops: NetnsLifecycleOps,
    entered: Arc<tokio::sync::Notify>,
    release: Arc<tokio::sync::Notify>,
    flush_count: Arc<AtomicUsize>,
    delete_count: Arc<AtomicUsize>,
}

fn counted_deleted_lifecycle() -> CountedLifecycle {
    counted_delete_lifecycle_with(
        ConntrackFlushOutcome::Trusted,
        NamespaceDeleteOutcome::Deleted,
    )
}

fn untrusted_flush_counted_deleted_lifecycle() -> CountedLifecycle {
    counted_delete_lifecycle_with(
        ConntrackFlushOutcome::Untrusted,
        NamespaceDeleteOutcome::Deleted,
    )
}

fn trusted_flush_counted_abandoned_delete_lifecycle() -> CountedLifecycle {
    counted_delete_lifecycle_with(
        ConntrackFlushOutcome::Trusted,
        NamespaceDeleteOutcome::Abandoned,
    )
}

fn untrusted_flush_counted_abandoned_delete_lifecycle() -> CountedLifecycle {
    counted_delete_lifecycle_with(
        ConntrackFlushOutcome::Untrusted,
        NamespaceDeleteOutcome::Abandoned,
    )
}

fn counted_delete_lifecycle_with(
    flush_outcome: ConntrackFlushOutcome,
    delete_outcome: NamespaceDeleteOutcome,
) -> CountedLifecycle {
    let flush_count = Arc::new(AtomicUsize::new(0));
    let delete_count = Arc::new(AtomicUsize::new(0));
    let flush_count_for_ops = Arc::clone(&flush_count);
    let delete_count_for_ops = Arc::clone(&delete_count);
    CountedLifecycle {
        ops: NetnsLifecycleOps {
            flush_conntrack: Arc::new(move |_| {
                let flush_count = Arc::clone(&flush_count_for_ops);
                Box::pin(async move {
                    flush_count.fetch_add(1, Ordering::SeqCst);
                    flush_outcome
                })
            }),
            delete_network_resources: Arc::new(move |namespaces, _| {
                let delete_count = Arc::clone(&delete_count_for_ops);
                let count = namespaces.len();
                Box::pin(async move {
                    delete_count.fetch_add(count, Ordering::SeqCst);
                    delete_outcome
                })
            }),
        },
        flush_count,
        delete_count,
    }
}

#[tokio::test]
async fn new_namespace_resets_conntrack_before_dns_readiness() {
    let phase = Arc::new(AtomicUsize::new(0));
    let phase_for_flush = Arc::clone(&phase);
    let phase_for_probe = Arc::clone(&phase);
    let ops = NetnsLifecycleOps {
        flush_conntrack: Arc::new(move |peer_ip| {
            let phase = Arc::clone(&phase_for_flush);
            Box::pin(async move {
                assert_eq!(peer_ip, "10.200.0.2");
                assert_eq!(phase.fetch_add(1, Ordering::SeqCst), 0);
                ConntrackFlushOutcome::Trusted
            })
        }),
        delete_network_resources: Arc::new(|_, _| {
            Box::pin(async { NamespaceDeleteOutcome::Deleted })
        }),
    };
    let probe = probe_for_test(move |namespace| {
        let phase = Arc::clone(&phase_for_probe);
        async move {
            assert_eq!(namespace, "vm0-ns-test-00");
            assert_eq!(phase.fetch_add(1, Ordering::SeqCst), 1);
            Ok(1)
        }
    });

    let namespace = create_namespace_with_readiness(
        async { Ok(test_info("vm0-ns-test-00")) },
        Some((probe, Duration::from_secs(1))),
        ops,
    )
    .await
    .unwrap();

    assert_eq!(namespace.name, "vm0-ns-test-00");
    assert_eq!(phase.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn untrusted_creation_conntrack_reset_deletes_namespace_before_readiness() {
    let lifecycle = untrusted_flush_counted_deleted_lifecycle();
    let probe_count = Arc::new(AtomicUsize::new(0));
    let probe_count_for_probe = Arc::clone(&probe_count);
    let probe = probe_for_test(move |_| {
        let probe_count = Arc::clone(&probe_count_for_probe);
        async move {
            probe_count.fetch_add(1, Ordering::SeqCst);
            Ok(1)
        }
    });

    let error = create_namespace_with_readiness(
        async { Ok(test_info("vm0-ns-test-00")) },
        Some((probe, Duration::from_secs(1))),
        lifecycle.ops,
    )
    .await
    .unwrap_err();

    assert!(matches!(
        error,
        NetworkError::ConntrackReset {
            namespace,
            peer_ip,
        } if namespace == "vm0-ns-test-00" && peer_ip == "10.200.0.2"
    ));
    assert_eq!(lifecycle.flush_count.load(Ordering::SeqCst), 1);
    assert_eq!(lifecycle.delete_count.load(Ordering::SeqCst), 1);
    assert_eq!(probe_count.load(Ordering::SeqCst), 0);
}

fn blocking_trusted_flush_lifecycle() -> BlockingFlushLifecycle {
    let entered = Arc::new(tokio::sync::Notify::new());
    let release = Arc::new(tokio::sync::Notify::new());
    let entered_for_ops = Arc::clone(&entered);
    let release_for_ops = Arc::clone(&release);
    BlockingFlushLifecycle {
        ops: NetnsLifecycleOps {
            flush_conntrack: Arc::new(move |_| {
                let entered = Arc::clone(&entered_for_ops);
                let release = Arc::clone(&release_for_ops);
                Box::pin(async move {
                    entered.notify_one();
                    release.notified().await;
                    ConntrackFlushOutcome::Trusted
                })
            }),
            delete_network_resources: Arc::new(|_, _| {
                Box::pin(async { NamespaceDeleteOutcome::Deleted })
            }),
        },
        entered,
        release,
    }
}

fn blocking_trusted_flush_counted_delete_lifecycle() -> BlockingFlushWithDeleteLifecycle {
    let entered = Arc::new(tokio::sync::Notify::new());
    let release = Arc::new(tokio::sync::Notify::new());
    let delete_count = Arc::new(AtomicUsize::new(0));
    let entered_for_ops = Arc::clone(&entered);
    let release_for_ops = Arc::clone(&release);
    let delete_count_for_ops = Arc::clone(&delete_count);
    BlockingFlushWithDeleteLifecycle {
        ops: NetnsLifecycleOps {
            flush_conntrack: Arc::new(move |_| {
                let entered = Arc::clone(&entered_for_ops);
                let release = Arc::clone(&release_for_ops);
                Box::pin(async move {
                    entered.notify_one();
                    release.notified().await;
                    ConntrackFlushOutcome::Trusted
                })
            }),
            delete_network_resources: Arc::new(move |namespaces, _| {
                let delete_count = Arc::clone(&delete_count_for_ops);
                let count = namespaces.len();
                Box::pin(async move {
                    delete_count.fetch_add(count, Ordering::SeqCst);
                    NamespaceDeleteOutcome::Deleted
                })
            }),
        },
        entered,
        release,
        delete_count,
    }
}

fn first_flush_blocks_then_trusted_lifecycle() -> FirstFlushBlocksLifecycle {
    let entered = Arc::new(tokio::sync::Notify::new());
    let release = Arc::new(tokio::sync::Notify::new());
    let flush_count = Arc::new(AtomicUsize::new(0));
    let delete_count = Arc::new(AtomicUsize::new(0));
    let entered_for_ops = Arc::clone(&entered);
    let release_for_ops = Arc::clone(&release);
    let flush_count_for_ops = Arc::clone(&flush_count);
    let delete_count_for_ops = Arc::clone(&delete_count);
    FirstFlushBlocksLifecycle {
        ops: NetnsLifecycleOps {
            flush_conntrack: Arc::new(move |_| {
                let entered = Arc::clone(&entered_for_ops);
                let release = Arc::clone(&release_for_ops);
                let flush_count = Arc::clone(&flush_count_for_ops);
                Box::pin(async move {
                    let attempt = flush_count.fetch_add(1, Ordering::SeqCst);
                    if attempt == 0 {
                        entered.notify_one();
                        release.notified().await;
                    }
                    ConntrackFlushOutcome::Trusted
                })
            }),
            delete_network_resources: Arc::new(move |namespaces, _| {
                let delete_count = Arc::clone(&delete_count_for_ops);
                let count = namespaces.len();
                Box::pin(async move {
                    delete_count.fetch_add(count, Ordering::SeqCst);
                    NamespaceDeleteOutcome::Deleted
                })
            }),
        },
        entered,
        release,
        flush_count,
        delete_count,
    }
}

fn first_delete_blocks_lifecycle() -> BlockingDeleteLifecycle {
    let entered = Arc::new(tokio::sync::Notify::new());
    let release = Arc::new(tokio::sync::Notify::new());
    let delete_count = Arc::new(AtomicUsize::new(0));
    let entered_for_ops = Arc::clone(&entered);
    let release_for_ops = Arc::clone(&release);
    let delete_count_for_ops = Arc::clone(&delete_count);
    BlockingDeleteLifecycle {
        ops: NetnsLifecycleOps {
            flush_conntrack: Arc::new(|_| Box::pin(async { ConntrackFlushOutcome::Trusted })),
            delete_network_resources: Arc::new(move |namespaces, _| {
                let entered = Arc::clone(&entered_for_ops);
                let release = Arc::clone(&release_for_ops);
                let delete_count = Arc::clone(&delete_count_for_ops);
                let count = namespaces.len();
                Box::pin(async move {
                    let attempt = delete_count.fetch_add(count, Ordering::SeqCst);
                    if attempt == 0 {
                        entered.notify_one();
                        release.notified().await;
                    }
                    NamespaceDeleteOutcome::Deleted
                })
            }),
        },
        entered,
        release,
        delete_count,
    }
}

fn first_untrusted_delete_blocks_then_deleted_lifecycle() -> FirstDeleteBlocksLifecycle {
    let entered = Arc::new(tokio::sync::Notify::new());
    let release = Arc::new(tokio::sync::Notify::new());
    let flush_count = Arc::new(AtomicUsize::new(0));
    let delete_count = Arc::new(AtomicUsize::new(0));
    let flush_count_for_ops = Arc::clone(&flush_count);
    let delete_count_for_ops = Arc::clone(&delete_count);
    let entered_for_ops = Arc::clone(&entered);
    let release_for_ops = Arc::clone(&release);
    FirstDeleteBlocksLifecycle {
        ops: NetnsLifecycleOps {
            flush_conntrack: Arc::new(move |_| {
                let flush_count = Arc::clone(&flush_count_for_ops);
                Box::pin(async move {
                    flush_count.fetch_add(1, Ordering::SeqCst);
                    ConntrackFlushOutcome::Untrusted
                })
            }),
            delete_network_resources: Arc::new(move |namespaces, _| {
                let delete_count = Arc::clone(&delete_count_for_ops);
                let entered = Arc::clone(&entered_for_ops);
                let release = Arc::clone(&release_for_ops);
                let count = namespaces.len();
                Box::pin(async move {
                    let attempt = delete_count.fetch_add(count, Ordering::SeqCst);
                    if attempt == 0 {
                        entered.notify_one();
                        release.notified().await;
                    }
                    NamespaceDeleteOutcome::Deleted
                })
            }),
        },
        entered,
        release,
        flush_count,
        delete_count,
    }
}

#[tokio::test]
async fn dns_pending_pool_rejects_acquire_without_removing_ready_entry() {
    let state = dns_pending_state(&["vm0-ns-test-00"], NetnsLifecycleOps::trusted_for_test());
    let mut pool = NetnsPool::from_state_for_test(state);

    let error = pool.acquire().await.unwrap_err();

    assert!(matches!(error, NetworkError::PoolDnsNotReady));
    assert_eq!(
        pool.inner
            .with_state_for_test(|state| state.proxy_queue.len()),
        1
    );
    pool.cleanup().await.unwrap();
}

#[tokio::test]
async fn dns_activation_admits_successfully_probed_initial_namespaces() {
    let calls = Arc::new(AtomicUsize::new(0));
    let calls_for_probe = Arc::clone(&calls);
    let mut state = dns_pending_state(
        &[
            "vm0-ns-test-00",
            "vm0-ns-test-01",
            "vm0-ns-test-02",
            "vm0-ns-test-03",
        ],
        NetnsLifecycleOps::trusted_for_test(),
    );
    state.dns_readiness_probe = probe_for_test(move |_| {
        let calls = Arc::clone(&calls_for_probe);
        async move {
            calls.fetch_add(1, Ordering::SeqCst);
            Ok(1)
        }
    });
    let mut pool = NetnsPool::from_state_for_test(state);

    pool.activate_dns_readiness().await.unwrap();

    assert_eq!(calls.load(Ordering::SeqCst), 4);
    assert!(pool.inner.with_state_for_test(|state| matches!(
        state.dns_readiness_state,
        DnsReadinessState::Ready
    )));
    let mut lease = Some(pool.acquire().await.unwrap());
    pool.release(&mut lease).await.unwrap();
    pool.cleanup().await.unwrap();
}

#[tokio::test]
async fn dns_activation_deletes_only_failed_initial_namespaces() {
    let lifecycle = counted_deleted_lifecycle();
    let mut state = dns_pending_state(
        &[
            "vm0-ns-test-00",
            "vm0-ns-test-01",
            "vm0-ns-test-02",
            "vm0-ns-test-03",
        ],
        lifecycle.ops,
    );
    state.dns_readiness_probe = probe_for_test(|namespace| async move {
        if namespace.ends_with("-02") {
            Err(DnsReadinessError::timeout())
        } else {
            Ok(1)
        }
    });
    let mut pool = NetnsPool::from_state_for_test(state);

    pool.activate_dns_readiness().await.unwrap();

    assert_eq!(lifecycle.delete_count.load(Ordering::SeqCst), 1);
    let names = pool.inner.with_state_for_test(|state| {
        state
            .proxy_queue
            .iter()
            .map(|namespace| namespace.name.clone())
            .collect::<Vec<_>>()
    });
    assert_eq!(names.len(), 3);
    assert!(!names.iter().any(|name| name.ends_with("-02")));
    pool.cleanup().await.unwrap();
}

#[tokio::test]
async fn dns_activation_fails_when_every_initial_probe_times_out() {
    let lifecycle = counted_deleted_lifecycle();
    let mut state = dns_pending_state(&["vm0-ns-test-00", "vm0-ns-test-01"], lifecycle.ops);
    state.dns_readiness_timeout = Duration::from_millis(10);
    state.dns_readiness_probe = probe_for_test(|_| async {
        std::future::pending::<std::result::Result<u16, DnsReadinessError>>().await
    });
    let mut pool = NetnsPool::from_state_for_test(state);

    let error = pool.activate_dns_readiness().await.unwrap_err();

    assert!(matches!(error, NetworkError::NoDnsReadyNamespaces));
    assert_eq!(lifecycle.delete_count.load(Ordering::SeqCst), 2);
    assert!(pool.inner.with_state_for_test(|state| {
        state.proxy_queue.is_empty()
            && matches!(state.dns_readiness_state, DnsReadinessState::Pending)
    }));
    pool.cleanup().await.unwrap();
}

#[tokio::test]
async fn cancelled_dns_activation_leaves_initial_entries_owned_by_pool() {
    let lifecycle = counted_deleted_lifecycle();
    let entered = Arc::new(tokio::sync::Notify::new());
    let release = Arc::new(tokio::sync::Notify::new());
    let entered_for_probe = Arc::clone(&entered);
    let release_for_probe = Arc::clone(&release);
    let mut state = dns_pending_state(&["vm0-ns-test-00"], lifecycle.ops);
    state.dns_readiness_probe = probe_for_test(move |_| {
        let entered = Arc::clone(&entered_for_probe);
        let release = Arc::clone(&release_for_probe);
        async move {
            entered.notify_one();
            release.notified().await;
            Ok(1)
        }
    });
    let mut pool = NetnsPool::from_state_for_test(state);
    let inner = pool.inner.clone();
    let activation = tokio::spawn(async move { inner.activate_dns_readiness().await });
    wait_for_sync("DNS readiness probe to start", entered.notified()).await;

    activation.abort();
    assert!(activation.await.unwrap_err().is_cancelled());
    assert!(pool.inner.with_state_for_test(|state| {
        state.proxy_queue.len() == 1
            && matches!(state.dns_readiness_state, DnsReadinessState::Activating)
    }));
    pool.cleanup().await.unwrap();
    assert_eq!(lifecycle.delete_count.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn post_activation_creation_is_probed_before_acquire() {
    let calls = Arc::new(AtomicUsize::new(0));
    let calls_for_probe = Arc::clone(&calls);
    let mut state = dns_pending_state(&[], NetnsLifecycleOps::trusted_for_test());
    state.dns_readiness_state = DnsReadinessState::Ready;
    state.dns_readiness_probe = probe_for_test(move |_| {
        let calls = Arc::clone(&calls_for_probe);
        async move {
            calls.fetch_add(1, Ordering::SeqCst);
            Ok(1)
        }
    });
    state.spawn_proxy_creation_for_test(async { Ok(test_info("vm0-ns-test-04")) });
    let mut pool = NetnsPool::from_state_for_test(state);

    let mut lease = Some(pool.acquire().await.unwrap());

    assert_eq!(lease.as_ref().unwrap().name(), "vm0-ns-test-04");
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    pool.release(&mut lease).await.unwrap();
    pool.cleanup().await.unwrap();
}

#[tokio::test]
async fn failed_post_activation_probe_is_deleted_and_returned_to_acquire() {
    let lifecycle = counted_deleted_lifecycle();
    let mut state = dns_pending_state(&[], lifecycle.ops);
    state.next_ns_index = 7;
    state.dns_readiness_state = DnsReadinessState::Ready;
    state.dns_readiness_probe = probe_for_test(|_| async { Err(DnsReadinessError::timeout()) });
    state.spawn_proxy_creation_for_test(async { Ok(test_info("vm0-ns-test-04")) });
    let mut pool = NetnsPool::from_state_for_test(state);

    let error = pool.acquire().await.unwrap_err();

    assert!(matches!(error, NetworkError::DnsReadiness(_)));
    assert_eq!(lifecycle.delete_count.load(Ordering::SeqCst), 1);
    assert!(pool.inner.with_state_for_test(|state| {
        state.proxy_queue.is_empty() && state.pending_proxy.is_empty() && state.next_ns_index == 7
    }));
    pool.cleanup().await.unwrap();
}

#[test]
fn not_required_acquire_returns_creation_failure_without_retrying() {
    let mut state = NetnsPoolState::inactive_for_test();
    state.active = true;
    state.next_ns_index = 7;
    let mut attempts = 0;

    let error = match state.prepare_acquire_with(|state, kind| {
        assert_eq!(kind, NetnsKind::Plain);
        state.reserve_ns_index()?;
        attempts += 1;
        let id = state.reserve_pending_id();
        state.pending_set_mut(kind).insert(id);
        state.completion.enqueue_for_test(CreationCompletion {
            id,
            kind,
            result: Err(NetworkError::Prerequisite(
                "injected plain namespace creation failure".into(),
            )),
        });
        Ok(())
    }) {
        Ok(_) => panic!("acquire planning should return the creation failure"),
        Err(error) => error,
    };

    assert!(matches!(
        error,
        NetworkError::Prerequisite(message)
            if message == "injected plain namespace creation failure"
    ));
    assert_eq!(attempts, 1);
    assert_eq!(state.next_ns_index, 8);
    assert!(state.pending_plain.is_empty());
    assert!(state.pending_proxy.is_empty());
    assert!(state.plain_queue.is_empty());
    assert!(state.proxy_queue.is_empty());
}

#[tokio::test]
async fn healthy_entry_wins_over_parallel_readiness_failure() {
    let lifecycle = counted_deleted_lifecycle();
    let mut state = dns_pending_state(&["vm0-ns-test-good"], lifecycle.ops);
    state.dns_readiness_state = DnsReadinessState::Ready;
    state.dns_readiness_probe = probe_for_test(|_| async { Err(DnsReadinessError::timeout()) });
    let prepared = state.completion.prepare_wait();
    assert!(prepared.completions.is_empty());
    let mut completion = prepared.receiver;
    state.spawn_proxy_creation_for_test(async { Ok(test_info("vm0-ns-test-bad")) });
    let mut pool = NetnsPool::from_state_for_test(state);
    wait_for_sync(
        "parallel proxy namespace creation to complete",
        completion.changed(),
    )
    .await
    .unwrap();

    let mut lease = Some(pool.acquire().await.unwrap());

    assert_eq!(lease.as_ref().unwrap().name(), "vm0-ns-test-good");
    assert!(pool.inner.with_state_for_test(|state| {
        state.creation_failure.is_some() && state.proxy_queue.is_empty()
    }));
    assert_eq!(lifecycle.delete_count.load(Ordering::SeqCst), 1);
    pool.release(&mut lease).await.unwrap();
    pool.cleanup().await.unwrap();
}

#[tokio::test]
async fn host_device_pattern_scopes_to_pool_index() {
    let mut pool = NetnsPoolState::inactive_for_test();
    pool.pool_index = 10;
    let handle = NetnsPoolHandle::from_state_for_test(pool);

    assert_eq!(handle.host_device_pattern().await, "vm0-ve-0a-*");
}

#[test]
fn runtime_replenish_fills_pending_to_buffer_with_existing_pending() {
    let mut pool = NetnsPoolState::inactive_for_test();
    pool.reserve_pending_creation_for_test(NetnsKind::Plain)
        .unwrap();

    pool.replenish_kind_with(
        NetnsKind::Plain,
        NetnsPoolState::reserve_pending_creation_for_test,
    );

    assert_eq!(pool.plain_queue.len(), 0);
    assert_eq!(pool.pending_plain.len(), BUFFER_SIZE);
    assert!(pool.pending_proxy.is_empty());
    assert_eq!(usize::try_from(pool.next_ns_index), Ok(BUFFER_SIZE));
    pool.pending_plain.clear();
}

#[test]
fn runtime_replenish_stops_at_namespace_limit() {
    let mut pool = NetnsPoolState::inactive_for_test();
    pool.next_ns_index = MAX_NAMESPACES - 1;

    pool.replenish_kind_with(
        NetnsKind::Plain,
        NetnsPoolState::reserve_pending_creation_for_test,
    );

    assert_eq!(pool.pending_plain.len(), 1);
    assert_eq!(pool.next_ns_index, MAX_NAMESPACES);

    pool.replenish_kind_with(
        NetnsKind::Plain,
        NetnsPoolState::reserve_pending_creation_for_test,
    );

    assert_eq!(pool.pending_plain.len(), 1);
    assert_eq!(pool.next_ns_index, MAX_NAMESPACES);
    pool.pending_plain.clear();
}

#[test]
fn runtime_replenish_uses_proxy_queue_in_proxy_mode() {
    let mut pool = NetnsPoolState::inactive_for_test();
    pool.proxy_port = Some(8080);
    pool.proxy_queue.push_back(test_info("ready-proxy"));

    pool.replenish_kind_with(
        NetnsKind::Proxy,
        NetnsPoolState::reserve_pending_creation_for_test,
    );

    assert_eq!(pool.proxy_queue.len(), 1);
    assert_eq!(pool.pending_proxy.len(), BUFFER_SIZE - 1);
    assert!(pool.pending_plain.is_empty());
    assert_eq!(usize::try_from(pool.next_ns_index), Ok(BUFFER_SIZE - 1));
    pool.pending_proxy.clear();
}

#[test]
fn runtime_replenish_keeps_high_water_until_below_buffer() {
    for (kind, proxy_port) in [(NetnsKind::Plain, None), (NetnsKind::Proxy, Some(8080))] {
        let mut pool = NetnsPoolState::inactive_for_test();
        pool.proxy_port = proxy_port;
        for index in 0..BUFFER_SIZE + 2 {
            pool.target_queue_mut(kind)
                .push_back(test_info(&format!("ready-ns-{index}")));
        }

        pool.replenish_kind_with(kind, NetnsPoolState::reserve_pending_creation_for_test);

        assert!(pool.pending_set(kind).is_empty());
        assert_eq!(pool.next_ns_index, 0);

        for _ in 0..2 {
            let _ = pool.target_queue_mut(kind).pop_front().unwrap();
        }
        pool.replenish_kind_with(kind, NetnsPoolState::reserve_pending_creation_for_test);

        assert_eq!(pool.target_queue(kind).len(), BUFFER_SIZE);
        assert!(pool.pending_set(kind).is_empty());
        assert_eq!(pool.next_ns_index, 0);

        let _ = pool.target_queue_mut(kind).pop_front().unwrap();
        pool.replenish_kind_with(kind, NetnsPoolState::reserve_pending_creation_for_test);

        assert_eq!(pool.target_queue(kind).len(), BUFFER_SIZE - 1);
        assert_eq!(pool.pending_set(kind).len(), 1);
        assert_eq!(pool.next_ns_index, 1);
        pool.pending_set_mut(kind).clear();
        pool.target_queue_mut(kind).clear();
    }
}

#[test]
fn runtime_replenish_ignores_proxy_kind_when_proxy_disabled() {
    let mut pool = NetnsPoolState::inactive_for_test();

    pool.replenish_kind_with(
        NetnsKind::Proxy,
        NetnsPoolState::reserve_pending_creation_for_test,
    );

    assert!(pool.pending_plain.is_empty());
    assert!(pool.pending_proxy.is_empty());
    assert_eq!(pool.next_ns_index, 0);
}

#[tokio::test]
async fn shared_acquire_does_not_hold_mutex_while_creation_is_pending() {
    let waiting = Arc::new(tokio::sync::Notify::new());
    let entered = Arc::new(tokio::sync::Notify::new());
    let release = Arc::new(tokio::sync::Notify::new());
    let mut pool = NetnsPoolState::inactive_for_test();
    pool.active = true;
    pool.next_ns_index = MAX_NAMESPACES;
    pool.acquire_waiting_notify = Some(Arc::clone(&waiting));
    pool.spawn_plain_creation_for_test(blocking_plain_creation(
        "test-ns",
        Arc::clone(&entered),
        Arc::clone(&release),
    ));
    let handle = NetnsPoolHandle::from_state_for_test(pool);

    let acquire = tokio::spawn({
        let handle = handle.clone();
        async move { handle.acquire().await }
    });
    wait_for_sync("plain namespace creation to start", entered.notified()).await;
    wait_for_sync(
        "shared acquire to wait for namespace creation",
        waiting.notified(),
    )
    .await;

    let guard = handle
        .inner
        .state
        .try_lock()
        .expect("shared acquire must not hold netns pool mutex while waiting");
    drop(guard);

    release.notify_one();
    let mut lease = Some(acquire.await.unwrap().unwrap());
    assert_eq!(lease.as_ref().unwrap().name(), "test-ns");
    let outcome = handle.release(&mut lease).await;
    assert!(matches!(outcome, NetnsReleaseOutcome::Released));
    handle.cleanup().await.unwrap();
}

#[tokio::test]
async fn shared_acquire_cancellation_preserves_completed_creation() {
    let waiting = Arc::new(tokio::sync::Notify::new());
    let entered = Arc::new(tokio::sync::Notify::new());
    let release = Arc::new(tokio::sync::Notify::new());
    let mut pool = NetnsPoolState::inactive_for_test();
    pool.active = true;
    pool.next_ns_index = MAX_NAMESPACES;
    pool.acquire_waiting_notify = Some(Arc::clone(&waiting));
    pool.spawn_plain_creation_for_test(blocking_plain_creation(
        "test-ns",
        Arc::clone(&entered),
        Arc::clone(&release),
    ));
    let handle = NetnsPoolHandle::from_state_for_test(pool);

    let acquire = tokio::spawn({
        let handle = handle.clone();
        async move { handle.acquire().await }
    });
    wait_for_sync(
        "plain namespace creation to start before acquire cancellation",
        entered.notified(),
    )
    .await;
    wait_for_sync(
        "shared acquire to wait before cancellation",
        waiting.notified(),
    )
    .await;
    acquire.abort();
    let _ = acquire.await;

    release.notify_one();
    let mut lease = Some(handle.acquire().await.unwrap());
    assert_eq!(lease.as_ref().unwrap().name(), "test-ns");

    let outcome = handle.release(&mut lease).await;
    assert!(matches!(outcome, NetnsReleaseOutcome::Released));
    handle.cleanup().await.unwrap();
}

#[tokio::test]
async fn creation_worker_panic_clears_pending_during_cleanup() {
    let mut pool = NetnsPoolState::inactive_for_test();
    pool.active = true;
    pool.spawn_plain_creation_for_test(async {
        panic!("creation panic for test");
        #[allow(unreachable_code)]
        Ok(test_info("never"))
    });
    let handle = NetnsPoolHandle::from_state_for_test(pool);

    handle.cleanup().await.unwrap();

    let pool = handle.inner.state.lock().await;
    assert!(pool.pending_plain.is_empty());
    assert!(pool.plain_queue.is_empty());
}

#[tokio::test]
async fn completion_send_failure_deletes_created_namespace() {
    let CountedLifecycle {
        ops,
        delete_count: deleted,
        ..
    } = counted_deleted_lifecycle();
    let mut pool = NetnsPoolState::inactive_for_test();
    pool.ops = ops;
    let notifier = pool.creation_notifier();
    drop(pool);

    notifier
        .send(CreationCompletion {
            id: PendingId(0),
            kind: NetnsKind::Plain,
            result: Ok(test_info("orphan-ns")),
        })
        .await;

    assert_eq!(deleted.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn cleanup_deletes_unknown_completed_namespace() {
    let CountedLifecycle {
        ops,
        delete_count: deleted,
        ..
    } = counted_deleted_lifecycle();
    let mut pool = NetnsPoolState::inactive_for_test();
    pool.active = true;
    pool.ops = ops;
    pool.completion.enqueue_for_test(CreationCompletion {
        id: PendingId(999),
        kind: NetnsKind::Plain,
        result: Ok(test_info("unknown-ns")),
    });

    let mut pool = NetnsPool::from_state_for_test(pool);
    pool.cleanup().await.unwrap();

    assert_eq!(deleted.load(Ordering::SeqCst), 1);
    let pool = pool.inner.state.lock().await;
    assert!(pool.plain_queue.is_empty());
    assert!(pool.proxy_queue.is_empty());
}

#[test]
fn netns_high_water_completion_retains_ready_entries_above_buffer() {
    for (kind, proxy_port) in [(NetnsKind::Plain, None), (NetnsKind::Proxy, Some(8080))] {
        let mut pool = NetnsPoolState::inactive_for_test();
        pool.active = true;
        pool.proxy_port = proxy_port;
        for index in 0..BUFFER_SIZE {
            pool.target_queue_mut(kind)
                .push_back(test_info(&format!("ready-ns-{index}")));
        }
        pool.reserve_pending_creation_for_test(kind).unwrap();
        pool.reserve_pending_creation_for_test(kind).unwrap();
        let pending_ids: Vec<PendingId> = pool.pending_set(kind).iter().copied().collect();
        assert_eq!(pending_ids.len(), 2);

        pool.completion.enqueue_for_test(CreationCompletion {
            id: pending_ids[0],
            kind,
            result: Ok(test_info("completed-ns-0")),
        });
        pool.completion.enqueue_for_test(CreationCompletion {
            id: pending_ids[1],
            kind,
            result: Ok(test_info("completed-ns-1")),
        });

        let delete = pool.drain_completed(false);
        let queue = pool.target_queue(kind);

        assert!(delete.is_empty());
        assert!(pool.pending_set(kind).is_empty());
        assert_eq!(queue.len(), BUFFER_SIZE + 2);
        assert!(queue.iter().any(|ns| ns.name == "completed-ns-0"));
        assert!(queue.iter().any(|ns| ns.name == "completed-ns-1"));
        pool.active = false;
        pool.target_queue_mut(kind).clear();
    }
}

#[tokio::test]
async fn cancelled_warmup_retains_pool_index_through_late_cleanup() {
    for kind in [NetnsKind::Plain, NetnsKind::Proxy] {
        let dir = tempfile::tempdir().unwrap();
        let locks = LockPaths::with_dir(dir.path().to_path_buf());
        let (index, lock) = acquire_pool_lock(&locks).unwrap();
        let entered = Arc::new(tokio::sync::Notify::new());
        let release = Arc::new(tokio::sync::Notify::new());
        let BlockingDeleteLifecycle {
            ops,
            entered: cleanup_entered,
            release: cleanup_release,
            delete_count,
        } = first_delete_blocks_lifecycle();
        let mut pool = NetnsPoolState::inactive_for_test();
        pool.pool_index = index;
        pool.index_lock = Arc::new(lock);
        pool.ops = ops;
        let creation =
            blocking_plain_creation("late-ns", Arc::clone(&entered), Arc::clone(&release));
        match kind {
            NetnsKind::Plain => pool.spawn_plain_creation_for_test(creation),
            NetnsKind::Proxy => pool.spawn_proxy_creation_for_test(creation),
        }
        {
            let warmup = async move { pool.drain_initial_warmup().await };
            tokio::pin!(warmup);
            tokio::select! {
                biased;
                _ = &mut warmup => panic!("warmup finished before creation was released"),
                _ = wait_for_sync("warmup creation to start", entered.notified()) => {}
            }
            let (other_index, _other_lock) = acquire_pool_lock(&locks).unwrap();
            assert_ne!(other_index, index);
            // Cancelling the constructor drops its local pool state.
        }

        let (replacement_index, _replacement_lock) = acquire_pool_lock(&locks).unwrap();
        assert_ne!(replacement_index, index, "creation still owns this index");
        release.notify_one();
        wait_for_sync(
            "late completion cleanup to start",
            cleanup_entered.notified(),
        )
        .await;
        let (during_cleanup_index, _during_cleanup_lock) = acquire_pool_lock(&locks).unwrap();
        assert_ne!(
            during_cleanup_index, index,
            "late cleanup still owns this index"
        );

        cleanup_release.notify_one();
        let _reused_lock = wait_for_pool_index_reuse(&locks, index).await;
        assert_eq!(delete_count.load(Ordering::SeqCst), 1);
    }
}

#[tokio::test]
async fn dropped_pool_retains_pool_index_through_creation_error_cleanup() {
    let dir = tempfile::tempdir().unwrap();
    let locks = LockPaths::with_dir(dir.path().to_path_buf());
    let (index, lock) = acquire_pool_lock(&locks).unwrap();
    let FirstDeleteBlocksLifecycle {
        ops,
        entered,
        release,
        flush_count,
        delete_count,
    } = first_untrusted_delete_blocks_then_deleted_lifecycle();
    let mut pool = NetnsPoolState::inactive_for_test();
    pool.pool_index = index;
    pool.index_lock = Arc::new(lock);
    pool.ops = ops;
    // The real creation wrapper deletes after a failed conntrack reset,
    // before the worker returns its error to the completion reporter.
    pool.spawn_proxy_creation_for_test(async { Ok(test_info("failed-ns")) });
    let pool = NetnsPoolHandle::from_state_for_test(pool);
    let last_handle = pool.clone();
    drop(pool);
    wait_for_sync("creation error cleanup to start", entered.notified()).await;
    drop(last_handle);

    let (replacement_index, _replacement_lock) = acquire_pool_lock(&locks).unwrap();
    assert_ne!(
        replacement_index, index,
        "worker cleanup still owns this index"
    );
    release.notify_one();
    let _reused_lock = wait_for_pool_index_reuse(&locks, index).await;
    assert_eq!(flush_count.load(Ordering::SeqCst), 1);
    assert_eq!(delete_count.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn dropped_pool_releases_pool_index_after_creation_panic() {
    let dir = tempfile::tempdir().unwrap();
    let locks = LockPaths::with_dir(dir.path().to_path_buf());
    let (index, lock) = acquire_pool_lock(&locks).unwrap();
    let entered = Arc::new(tokio::sync::Notify::new());
    let release = Arc::new(tokio::sync::Notify::new());
    let mut pool = NetnsPoolState::inactive_for_test();
    pool.pool_index = index;
    pool.index_lock = Arc::new(lock);
    pool.spawn_plain_creation_for_test({
        let entered = Arc::clone(&entered);
        let release = Arc::clone(&release);
        async move {
            entered.notify_one();
            release.notified().await;
            panic!("synthetic namespace creation panic");
        }
    });
    wait_for_sync("panicking creation to start", entered.notified()).await;
    drop(NetnsPoolHandle::from_state_for_test(pool));

    let (replacement_index, _replacement_lock) = acquire_pool_lock(&locks).unwrap();
    assert_ne!(replacement_index, index, "creation has not panicked yet");
    release.notify_one();
    let _reused_lock = wait_for_pool_index_reuse(&locks, index).await;
}

#[tokio::test]
async fn cancelled_reporter_keeps_pool_index_while_worker_cleans_up() {
    let dir = tempfile::tempdir().unwrap();
    let locks = LockPaths::with_dir(dir.path().to_path_buf());
    let (index, lock) = acquire_pool_lock(&locks).unwrap();
    let FirstDeleteBlocksLifecycle {
        ops,
        entered,
        release,
        delete_count,
        ..
    } = first_untrusted_delete_blocks_then_deleted_lifecycle();
    let mut pool = NetnsPoolState::inactive_for_test();
    pool.pool_index = index;
    pool.index_lock = Arc::new(lock);
    let reporter = spawn_creation_worker(
        PendingId(0),
        NetnsKind::Proxy,
        Arc::clone(&pool.index_lock),
        pool.creation_notifier(),
        create_namespace_with_readiness(async { Ok(test_info("failed-ns")) }, None, ops),
    );
    wait_for_sync(
        "worker cleanup before reporter cancellation",
        entered.notified(),
    )
    .await;
    reporter.abort();
    let error = wait_for_sync("reporter cancellation", reporter)
        .await
        .unwrap_err();
    assert!(error.is_cancelled());
    drop(pool);

    let (replacement_index, _replacement_lock) = acquire_pool_lock(&locks).unwrap();
    assert_ne!(
        replacement_index, index,
        "detached worker still owns this index"
    );
    release.notify_one();
    let _reused_lock = wait_for_pool_index_reuse(&locks, index).await;
    assert_eq!(delete_count.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn cleanup_rejects_acquire_and_deletes_late_completion() {
    let release = Arc::new(tokio::sync::Notify::new());
    let CountedLifecycle {
        ops, delete_count, ..
    } = counted_deleted_lifecycle();
    let mut pool = NetnsPoolState::inactive_for_test();
    pool.active = true;
    pool.ops = ops;
    pool.spawn_plain_creation_for_test({
        let release = Arc::clone(&release);
        async move {
            release.notified().await;
            Ok(test_info("late-ns"))
        }
    });
    let handle = NetnsPoolHandle::from_state_for_test(pool);

    let cleanup = tokio::spawn({
        let handle = handle.clone();
        async move { handle.cleanup().await }
    });
    wait_for_sync("cleanup to mark namespace pool inactive", async {
        loop {
            if !handle.inner.state.lock().await.active {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await;

    let err = handle.acquire().await.unwrap_err();
    assert!(matches!(err, NetworkError::PoolNotActive));

    release.notify_one();
    cleanup.await.unwrap().unwrap();
    let pool = handle.inner.state.lock().await;
    assert!(pool.pending_plain.is_empty());
    assert!(pool.plain_queue.is_empty());
    assert_eq!(delete_count.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn shared_release_does_not_hold_mutex_while_flush_blocks() {
    let BlockingFlushLifecycle {
        ops,
        entered: flush_entered,
        release: flush_release,
    } = blocking_trusted_flush_lifecycle();
    let mut pool = NetnsPoolState::inactive_for_test();
    pool.active = true;
    pool.ops = ops;
    let lease = Some(pool.checkout(test_info("test-ns")).unwrap());
    let handle = NetnsPoolHandle::from_state_for_test(pool);

    let release_task = tokio::spawn({
        let handle = handle.clone();
        async move {
            let mut lease = lease;
            let outcome = handle.release(&mut lease).await;
            (outcome, lease)
        }
    });
    wait_for_sync(
        "shared release conntrack flush to start",
        flush_entered.notified(),
    )
    .await;

    let guard = handle
        .inner
        .state
        .try_lock()
        .expect("shared release must not hold netns pool mutex while flushing conntrack");
    drop(guard);

    flush_release.notify_one();
    let (outcome, lease) = release_task.await.unwrap();
    assert!(matches!(outcome, NetnsReleaseOutcome::Released));
    assert!(lease.is_none());
    handle.cleanup().await.unwrap();
}

#[tokio::test]
async fn shared_release_deletes_when_cleanup_races_after_flush_started() {
    let BlockingFlushWithDeleteLifecycle {
        ops,
        entered: flush_entered,
        release: flush_release,
        delete_count,
    } = blocking_trusted_flush_counted_delete_lifecycle();
    let mut pool = NetnsPoolState::inactive_for_test();
    pool.active = true;
    pool.ops = ops;
    let lease = Some(pool.checkout(test_info("test-ns")).unwrap());
    let handle = NetnsPoolHandle::from_state_for_test(pool);

    let release_task = tokio::spawn({
        let handle = handle.clone();
        async move {
            let mut lease = lease;
            let outcome = handle.release(&mut lease).await;
            (outcome, lease)
        }
    });
    wait_for_sync(
        "shared release conntrack flush to start before cleanup",
        flush_entered.notified(),
    )
    .await;

    handle.cleanup().await.unwrap();
    flush_release.notify_one();
    let (outcome, lease) = release_task.await.unwrap();

    assert!(matches!(outcome, NetnsReleaseOutcome::Deleted));
    assert!(lease.is_none());
    assert_eq!(delete_count.load(Ordering::SeqCst), 1);
    let pool = handle.inner.state.lock().await;
    assert!(!pool.active);
    assert!(pool.in_flight.is_empty());
    assert!(pool.plain_queue.is_empty());
}

#[tokio::test]
async fn cancelled_release_during_flush_marks_namespace_non_reusable_for_retry() {
    let FirstFlushBlocksLifecycle {
        ops,
        entered: flush_entered,
        release: first_flush_release,
        flush_count,
        delete_count,
    } = first_flush_blocks_then_trusted_lifecycle();
    let mut pool = NetnsPoolState::inactive_for_test();
    pool.active = true;
    pool.ops = ops;
    let mut lease = Some(pool.checkout(test_info("test-ns")).unwrap());
    let handle = NetnsPoolHandle::from_state_for_test(pool);

    {
        let release = handle.release(&mut lease);
        tokio::pin!(release);
        tokio::select! {
            outcome = &mut release => panic!("release completed before flush was cancelled: {outcome:?}"),
            _ = wait_for_sync(
                "release conntrack flush to start before cancellation",
                flush_entered.notified(),
            ) => {}
        }
    }

    assert!(lease.is_some());
    assert_eq!(flush_count.load(Ordering::SeqCst), 1);
    {
        let pool = handle.inner.state.lock().await;
        assert!(pool.non_reusable.contains("test-ns"));
    }

    first_flush_release.notify_one();
    let outcome = handle.release(&mut lease).await;

    assert!(matches!(outcome, NetnsReleaseOutcome::Deleted));
    assert!(lease.is_none());
    assert_eq!(
        flush_count.load(Ordering::SeqCst),
        1,
        "cancelled flush must taint the namespace before retry"
    );
    assert_eq!(delete_count.load(Ordering::SeqCst), 1);
    let pool = handle.inner.state.lock().await;
    assert!(pool.non_reusable.is_empty());
    assert!(pool.plain_queue.is_empty());
}

#[tokio::test]
async fn release_cancelled_after_trusted_flush_before_commit_deletes_on_retry() {
    let FirstFlushBlocksLifecycle {
        ops,
        entered: flush_entered,
        release: first_flush_release,
        flush_count,
        delete_count,
    } = first_flush_blocks_then_trusted_lifecycle();
    let mut pool = NetnsPoolState::inactive_for_test();
    pool.active = true;
    pool.ops = ops;
    let mut lease = Some(pool.checkout(test_info("test-ns")).unwrap());
    let handle = NetnsPoolHandle::from_state_for_test(pool);

    let mut release = Box::pin(handle.release(&mut lease));
    tokio::select! {
        outcome = &mut release => panic!("release completed before flush finished: {outcome:?}"),
        _ = wait_for_sync(
            "trusted release conntrack flush to start",
            flush_entered.notified(),
        ) => {}
    }
    let guard = handle.inner.state.lock().await;
    first_flush_release.notify_one();
    tokio::select! {
        outcome = &mut release => panic!("release completed while pool lock was held: {outcome:?}"),
        _ = tokio::task::yield_now() => {}
    }
    assert!(guard.non_reusable.contains("test-ns"));
    drop(release);

    assert!(lease.is_some());
    assert_eq!(flush_count.load(Ordering::SeqCst), 1);
    drop(guard);

    let outcome = handle.release(&mut lease).await;

    assert!(matches!(outcome, NetnsReleaseOutcome::Deleted));
    assert!(lease.is_none());
    assert_eq!(
        flush_count.load(Ordering::SeqCst),
        1,
        "cancelled post-flush commit must not flush/requeue on retry"
    );
    assert_eq!(delete_count.load(Ordering::SeqCst), 1);
    let pool = handle.inner.state.lock().await;
    assert!(pool.non_reusable.is_empty());
    assert!(pool.in_flight.is_empty());
    assert!(pool.plain_queue.is_empty());
}

#[tokio::test]
async fn direct_release_cancelled_during_flush_marks_namespace_non_reusable_for_retry() {
    let FirstFlushBlocksLifecycle {
        ops,
        entered: flush_entered,
        release: first_flush_release,
        flush_count,
        delete_count,
    } = first_flush_blocks_then_trusted_lifecycle();
    let mut pool = NetnsPoolState::inactive_for_test();
    pool.active = true;
    pool.ops = ops;
    let mut lease = Some(pool.checkout(test_info("test-ns")).unwrap());
    let mut pool = NetnsPool::from_state_for_test(pool);

    {
        let release = pool.release(&mut lease);
        tokio::pin!(release);
        tokio::select! {
            result = &mut release => panic!("release completed before flush was cancelled: {result:?}"),
            _ = wait_for_sync(
                "direct release conntrack flush to start before cancellation",
                flush_entered.notified(),
            ) => {}
        }
    }

    assert!(lease.is_some());
    assert_eq!(flush_count.load(Ordering::SeqCst), 1);
    {
        let pool = pool.inner.state.lock().await;
        assert!(pool.non_reusable.contains("test-ns"));
    }

    first_flush_release.notify_one();
    pool.release(&mut lease).await.unwrap();

    assert!(lease.is_none());
    assert_eq!(
        flush_count.load(Ordering::SeqCst),
        1,
        "direct cancelled flush must taint the namespace before retry"
    );
    assert_eq!(delete_count.load(Ordering::SeqCst), 1);
    let pool = pool.inner.state.lock().await;
    assert!(pool.non_reusable.is_empty());
    assert!(pool.plain_queue.is_empty());
}

#[tokio::test]
async fn untrusted_conntrack_flush_deletes_without_requeue() {
    let CountedLifecycle {
        ops, delete_count, ..
    } = untrusted_flush_counted_deleted_lifecycle();
    let mut pool = NetnsPoolState::inactive_for_test();
    pool.active = true;
    pool.ops = ops;
    let mut lease = Some(pool.checkout(test_info("test-ns")).unwrap());
    let handle = NetnsPoolHandle::from_state_for_test(pool);

    let outcome = handle.release(&mut lease).await;

    assert!(matches!(outcome, NetnsReleaseOutcome::Deleted));
    assert!(lease.is_none());
    assert_eq!(delete_count.load(Ordering::SeqCst), 1);
    let pool = handle.inner.state.lock().await;
    assert!(pool.in_flight.is_empty());
    assert!(pool.plain_queue.is_empty());
}

#[tokio::test]
async fn attachment_marked_non_reusable_is_deleted_without_conntrack_flush() {
    let CountedLifecycle {
        ops,
        flush_count,
        delete_count,
    } = counted_deleted_lifecycle();
    let mut pool = NetnsPoolState::inactive_for_test();
    pool.active = true;
    pool.ops = ops;
    let mut lease = pool.checkout(test_info("failed-ns")).unwrap();
    lease.mark_non_reusable();
    let mut lease = Some(lease);
    let handle = NetnsPoolHandle::from_state_for_test(pool);

    let outcome = handle.release(&mut lease).await;

    assert!(matches!(outcome, NetnsReleaseOutcome::Deleted));
    assert!(lease.is_none());
    assert_eq!(flush_count.load(Ordering::SeqCst), 0);
    assert_eq!(delete_count.load(Ordering::SeqCst), 1);
    let pool = handle.inner.state.lock().await;
    assert!(pool.in_flight.is_empty());
    assert!(pool.plain_queue.is_empty());
}

#[tokio::test]
async fn attachment_reapproved_after_readiness_uses_normal_release_path() {
    let CountedLifecycle {
        ops,
        flush_count,
        delete_count,
    } = counted_deleted_lifecycle();
    let mut pool = NetnsPoolState::inactive_for_test();
    pool.active = true;
    pool.ops = ops;
    let mut lease = pool.checkout(test_info("ready-ns")).unwrap();
    lease.mark_non_reusable();
    lease.mark_reusable();
    let mut lease = Some(lease);
    let handle = NetnsPoolHandle::from_state_for_test(pool);

    let outcome = handle.release(&mut lease).await;

    assert!(matches!(outcome, NetnsReleaseOutcome::Released));
    assert!(lease.is_none());
    assert_eq!(flush_count.load(Ordering::SeqCst), 1);
    assert_eq!(delete_count.load(Ordering::SeqCst), 0);
    let pool = handle.inner.state.lock().await;
    assert!(pool.in_flight.is_empty());
    assert_eq!(pool.plain_queue.len(), 1);
    assert_eq!(pool.plain_queue.front().unwrap().name(), "ready-ns");
}

#[tokio::test]
async fn cancelled_untrusted_release_marks_namespace_non_reusable_for_retry() {
    let FirstDeleteBlocksLifecycle {
        ops,
        entered: delete_entered,
        release: first_delete_release,
        flush_count,
        delete_count,
    } = first_untrusted_delete_blocks_then_deleted_lifecycle();
    let mut pool = NetnsPoolState::inactive_for_test();
    pool.active = true;
    pool.ops = ops;
    let mut lease = Some(pool.checkout(test_info("test-ns")).unwrap());
    let handle = NetnsPoolHandle::from_state_for_test(pool);

    {
        let release = handle.release(&mut lease);
        tokio::pin!(release);
        tokio::select! {
            outcome = &mut release => panic!("release completed before delete was cancelled: {outcome:?}"),
            _ = wait_for_sync(
                "untrusted release namespace deletion to start",
                delete_entered.notified(),
            ) => {}
        }
    }

    assert!(lease.is_some());
    assert_eq!(flush_count.load(Ordering::SeqCst), 1);
    assert_eq!(delete_count.load(Ordering::SeqCst), 1);
    {
        let pool = handle.inner.state.lock().await;
        assert!(pool.non_reusable.contains("test-ns"));
    }

    first_delete_release.notify_one();
    let outcome = handle.release(&mut lease).await;

    assert!(matches!(outcome, NetnsReleaseOutcome::Deleted));
    assert!(lease.is_none());
    assert_eq!(
        flush_count.load(Ordering::SeqCst),
        1,
        "tainted retry must not flush and requeue"
    );
    assert_eq!(delete_count.load(Ordering::SeqCst), 2);
    let pool = handle.inner.state.lock().await;
    assert!(pool.non_reusable.is_empty());
    assert!(pool.plain_queue.is_empty());
}

#[tokio::test]
async fn release_cancelled_after_delete_before_commit_retries_delete_without_flush() {
    let FirstDeleteBlocksLifecycle {
        ops,
        entered: delete_entered,
        release: first_delete_release,
        flush_count,
        delete_count,
    } = first_untrusted_delete_blocks_then_deleted_lifecycle();
    let mut pool = NetnsPoolState::inactive_for_test();
    pool.active = true;
    pool.ops = ops;
    let mut lease = Some(pool.checkout(test_info("test-ns")).unwrap());
    let handle = NetnsPoolHandle::from_state_for_test(pool);

    let mut release = Box::pin(handle.release(&mut lease));
    tokio::select! {
        outcome = &mut release => panic!("release completed before delete finished: {outcome:?}"),
        _ = wait_for_sync(
            "namespace deletion to start before release commit",
            delete_entered.notified(),
        ) => {}
    }
    let guard = handle.inner.state.lock().await;
    first_delete_release.notify_one();
    tokio::select! {
        outcome = &mut release => panic!("release completed while pool lock was held: {outcome:?}"),
        _ = tokio::task::yield_now() => {}
    }
    assert!(guard.non_reusable.contains("test-ns"));
    drop(release);

    assert!(lease.is_some());
    assert_eq!(flush_count.load(Ordering::SeqCst), 1);
    assert_eq!(delete_count.load(Ordering::SeqCst), 1);
    drop(guard);

    let outcome = handle.release(&mut lease).await;

    assert!(matches!(outcome, NetnsReleaseOutcome::Deleted));
    assert!(lease.is_none());
    assert_eq!(
        flush_count.load(Ordering::SeqCst),
        1,
        "tainted post-delete retry must not flush/requeue"
    );
    assert_eq!(delete_count.load(Ordering::SeqCst), 2);
    let pool = handle.inner.state.lock().await;
    assert!(pool.non_reusable.is_empty());
    assert!(pool.in_flight.is_empty());
    assert!(pool.plain_queue.is_empty());
}

#[tokio::test]
async fn shared_cleanup_does_not_hold_mutex_while_delete_blocks() {
    let BlockingDeleteLifecycle {
        ops,
        entered: delete_entered,
        release: delete_release,
        ..
    } = first_delete_blocks_lifecycle();
    let mut pool = NetnsPoolState::inactive_for_test();
    pool.active = true;
    pool.plain_queue.push_back(test_info("test-ns"));
    pool.ops = ops;
    let handle = NetnsPoolHandle::from_state_for_test(pool);

    let cleanup = tokio::spawn({
        let handle = handle.clone();
        async move { handle.cleanup().await }
    });
    wait_for_sync(
        "shared cleanup namespace deletion to start",
        delete_entered.notified(),
    )
    .await;

    let guard = handle
        .inner
        .state
        .try_lock()
        .expect("shared cleanup must not hold netns pool mutex while deleting namespace");
    drop(guard);

    delete_release.notify_one();
    cleanup.await.unwrap().unwrap();
    let pool = handle.inner.state.lock().await;
    assert!(pool.plain_queue.is_empty());
}

#[tokio::test]
async fn shared_cleanup_retry_keeps_queue_when_cancelled_during_delete() {
    let BlockingDeleteLifecycle {
        ops,
        entered: delete_entered,
        release: delete_release,
        delete_count,
    } = first_delete_blocks_lifecycle();
    let mut pool = NetnsPoolState::inactive_for_test();
    pool.active = true;
    pool.plain_queue.push_back(test_info("test-ns"));
    pool.ops = ops;
    let handle = NetnsPoolHandle::from_state_for_test(pool);

    let cleanup = tokio::spawn({
        let handle = handle.clone();
        async move { handle.cleanup().await }
    });
    wait_for_sync(
        "cleanup namespace deletion to start before cancellation",
        delete_entered.notified(),
    )
    .await;
    cleanup.abort();
    let _ = cleanup.await;

    {
        let pool = handle.inner.state.lock().await;
        assert!(!pool.active);
        assert_eq!(pool.plain_queue.len(), 1);
        assert_eq!(pool.plain_queue.front().unwrap().name(), "test-ns");
    }

    delete_release.notify_one();
    handle.cleanup().await.unwrap();
    let pool = handle.inner.state.lock().await;
    assert!(pool.plain_queue.is_empty());
    assert_eq!(delete_count.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn release_disarms_lease_and_returns_info_to_queue() {
    let mut pool = NetnsPoolState::inactive_for_test();
    pool.active = true;
    let info = test_info("test-ns");
    let mut lease = Some(pool.checkout(info).unwrap());
    let mut pool = NetnsPool::from_state_for_test(pool);

    pool.release(&mut lease).await.unwrap();

    assert!(lease.is_none());
    {
        let pool = pool.inner.state.lock().await;
        assert!(pool.in_flight.is_empty());
        assert_eq!(pool.plain_queue.len(), 1);
        assert_eq!(pool.plain_queue.front().unwrap().name(), "test-ns");
    }

    pool.cleanup().await.unwrap();
}

#[tokio::test]
async fn netns_high_water_release_retains_ready_entries_above_buffer() {
    for (kind, proxy_port) in [(NetnsKind::Plain, None), (NetnsKind::Proxy, Some(8080))] {
        let mut state = NetnsPoolState::inactive_for_test();
        state.active = true;
        state.proxy_port = proxy_port;
        let mut leases: Vec<Option<NetnsLease>> = (0..BUFFER_SIZE + 2)
            .map(|index| {
                Some(
                    state
                        .checkout(test_info(&format!("released-ns-{index}")))
                        .unwrap(),
                )
            })
            .collect();
        let mut pool = NetnsPool::from_state_for_test(state);

        for lease in &mut leases {
            pool.release(lease).await.unwrap();
        }

        assert!(leases.iter().all(Option::is_none));
        {
            let state = pool.inner.state.lock().await;
            let queue = state.target_queue(kind);
            let last_released_name = format!("released-ns-{}", BUFFER_SIZE + 1);
            assert!(state.in_flight.is_empty());
            assert_eq!(queue.len(), BUFFER_SIZE + 2);
            assert!(queue.iter().any(|ns| ns.name == "released-ns-0"));
            assert!(queue.iter().any(|ns| ns.name == last_released_name));
        }

        pool.cleanup().await.unwrap();
    }
}

#[tokio::test]
async fn proxy_release_disarms_lease_and_returns_info_to_proxy_queue() {
    let mut pool = NetnsPoolState::inactive_for_test();
    pool.active = true;
    pool.proxy_port = Some(8080);
    let info = test_info("test-ns");
    let mut lease = Some(pool.checkout(info).unwrap());
    let mut pool = NetnsPool::from_state_for_test(pool);

    pool.release(&mut lease).await.unwrap();

    assert!(lease.is_none());
    {
        let pool = pool.inner.state.lock().await;
        assert!(pool.in_flight.is_empty());
        assert!(pool.plain_queue.is_empty());
        assert_eq!(pool.proxy_queue.len(), 1);
        assert_eq!(pool.proxy_queue.front().unwrap().name(), "test-ns");
    }

    pool.cleanup().await.unwrap();
}

#[tokio::test]
async fn release_after_cleanup_deletes_outstanding_lease_without_requeueing() {
    let mut pool = NetnsPoolState::inactive_for_test();
    pool.active = true;
    let info = test_info("test-ns");
    let mut lease = Some(pool.checkout(info).unwrap());
    let mut pool = NetnsPool::from_state_for_test(pool);

    pool.cleanup().await.unwrap();

    assert!(lease.is_some());
    {
        let pool = pool.inner.state.lock().await;
        assert!(!pool.active);
        assert!(pool.in_flight.contains("test-ns"));
    }

    pool.release(&mut lease).await.unwrap();

    assert!(lease.is_none());
    {
        let pool = pool.inner.state.lock().await;
        assert!(pool.in_flight.is_empty());
        assert!(pool.plain_queue.is_empty());
        assert!(pool.proxy_queue.is_empty());
    }
    pool.cleanup().await.unwrap();
}

#[tokio::test]
async fn release_abandoned_delete_consumes_lease_and_clears_tracking() {
    let CountedLifecycle {
        ops, delete_count, ..
    } = untrusted_flush_counted_abandoned_delete_lifecycle();
    let mut pool = NetnsPoolState::inactive_for_test();
    pool.active = true;
    pool.ops = ops;
    let mut lease = Some(pool.checkout(test_info("test-ns")).unwrap());
    let pool = NetnsPool::from_state_for_test(pool);

    let outcome = pool.inner.release_outcome(&mut lease).await;

    assert!(matches!(outcome, NetnsReleaseOutcome::Abandoned));
    assert!(lease.is_none());
    assert_eq!(delete_count.load(Ordering::SeqCst), 1);
    let pool = pool.inner.state.lock().await;
    assert!(pool.in_flight.is_empty());
    assert!(pool.non_reusable.is_empty());
    assert!(pool.plain_queue.is_empty());
}

#[tokio::test]
async fn cleanup_retry_drains_pending_creation_after_cancel() {
    let mut pool = NetnsPoolState::inactive_for_test();
    pool.active = true;
    let entered = std::sync::Arc::new(tokio::sync::Notify::new());
    let release = std::sync::Arc::new(tokio::sync::Notify::new());
    let entered_task = std::sync::Arc::clone(&entered);
    let release_task = std::sync::Arc::clone(&release);
    pool.spawn_plain_creation_for_test(async move {
        entered_task.notify_one();
        release_task.notified().await;
        Ok(test_info("test-ns"))
    });
    let mut pool = NetnsPool::from_state_for_test(pool);

    {
        let cleanup = pool.cleanup();
        tokio::pin!(cleanup);
        tokio::select! {
            result = &mut cleanup => panic!("cleanup completed before pending task was released: {result:?}"),
            _ = wait_for_sync(
                "pending namespace creation to start before cleanup cancellation",
                entered.notified(),
            ) => {}
        }
    }

    {
        let pool = pool.inner.state.lock().await;
        assert!(!pool.active);
        assert_eq!(pool.pending_plain.len(), 1);
    }

    release.notify_one();
    pool.cleanup().await.unwrap();

    let pool = pool.inner.state.lock().await;
    assert!(!pool.active);
    assert!(pool.pending_plain.is_empty());
    assert!(pool.plain_queue.is_empty());
}

#[tokio::test]
async fn acquire_cancellation_keeps_pending_creation_for_cleanup() {
    let mut pool = NetnsPoolState::inactive_for_test();
    pool.active = true;
    let entered = std::sync::Arc::new(tokio::sync::Notify::new());
    let release = std::sync::Arc::new(tokio::sync::Notify::new());
    let entered_task = std::sync::Arc::clone(&entered);
    let release_task = std::sync::Arc::clone(&release);
    pool.spawn_plain_creation_for_test(async move {
        entered_task.notify_one();
        release_task.notified().await;
        Ok(test_info("test-ns"))
    });
    let mut pool = NetnsPool::from_state_for_test(pool);

    {
        let acquire = pool.acquire();
        tokio::pin!(acquire);
        tokio::select! {
            result = &mut acquire => panic!("acquire completed before pending task was released: {result:?}"),
            _ = wait_for_sync(
                "pending namespace creation to start before acquire cancellation",
                entered.notified(),
            ) => {}
        }
    }

    {
        let pool = pool.inner.state.lock().await;
        assert!(pool.in_flight.is_empty());
        assert_eq!(pool.pending_plain.len(), 1);
    }

    release.notify_one();
    pool.cleanup().await.unwrap();

    let pool = pool.inner.state.lock().await;
    assert!(!pool.active);
    assert!(pool.pending_plain.is_empty());
    assert!(pool.plain_queue.is_empty());
}

#[tokio::test]
async fn delete_queued_namespaces_keeps_front_entry_when_cancelled() {
    let mut queue = VecDeque::from([test_info("test-ns")]);
    let entered = std::sync::Arc::new(tokio::sync::Notify::new());
    let release = std::sync::Arc::new(tokio::sync::Notify::new());

    let delete = {
        let entered = std::sync::Arc::clone(&entered);
        let release = std::sync::Arc::clone(&release);
        move |ns: NetnsInfo| {
            assert_eq!(ns.name(), "test-ns");
            let entered = std::sync::Arc::clone(&entered);
            let release = std::sync::Arc::clone(&release);
            async move {
                entered.notify_one();
                release.notified().await;
            }
        }
    };
    {
        let deletion = NetnsPoolState::delete_queued_namespaces_with(&mut queue, delete);
        tokio::pin!(deletion);
        tokio::select! {
            _ = &mut deletion => panic!("delete completed before test released it"),
            _ = wait_for_sync(
                "queued namespace deletion to start before cancellation",
                entered.notified(),
            ) => {}
        }
    }

    assert_eq!(queue.len(), 1);
    assert_eq!(queue.front().unwrap().name(), "test-ns");

    release.notify_one();
    NetnsPoolState::delete_queued_namespaces_with(&mut queue, |_| async {}).await;
    assert!(queue.is_empty());
}

#[tokio::test]
async fn cleanup_retries_when_pool_is_inactive_but_not_drained() {
    let mut pool = NetnsPoolState::inactive_for_test();
    pool.plain_queue.push_back(test_info("test-ns"));
    let mut pool = NetnsPool::from_state_for_test(pool);

    pool.cleanup().await.unwrap();

    let pool = pool.inner.state.lock().await;
    assert!(!pool.active);
    assert!(pool.plain_queue.is_empty());
}

#[tokio::test]
async fn cleanup_batches_queued_namespaces_and_dns_filter() {
    let calls = Arc::new(Mutex::new(Vec::new()));
    let calls_for_ops = Arc::clone(&calls);
    let ops = NetnsLifecycleOps {
        flush_conntrack: Arc::new(|_| Box::pin(async { ConntrackFlushOutcome::Trusted })),
        delete_network_resources: Arc::new(move |namespaces, dns_comment| {
            let calls = Arc::clone(&calls_for_ops);
            Box::pin(async move {
                calls.lock().unwrap().push((
                    namespaces
                        .into_iter()
                        .map(|namespace| namespace.name)
                        .collect::<Vec<_>>(),
                    dns_comment,
                ));
                NamespaceDeleteOutcome::Deleted
            })
        }),
    };
    let mut state = NetnsPoolState::inactive_for_test();
    state.active = true;
    state.plain_queue.push_back(test_info("plain-ns"));
    state.proxy_queue.push_back(test_info("proxy-ns"));
    state.dns_input_filter_comment = Some("vm0-ns-00-dns".into());
    state.ops = ops;
    let mut pool = NetnsPool::from_state_for_test(state);

    pool.cleanup().await.unwrap();

    let calls = calls.lock().unwrap();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].0, ["plain-ns", "proxy-ns"]);
    assert_eq!(calls[0].1.as_deref(), Some("vm0-ns-00-dns"));
}

#[tokio::test]
async fn cleanup_removes_queued_namespace_after_abandoned_delete() {
    let CountedLifecycle {
        ops, delete_count, ..
    } = trusted_flush_counted_abandoned_delete_lifecycle();
    let mut pool = NetnsPoolState::inactive_for_test();
    pool.active = true;
    pool.plain_queue.push_back(test_info("test-ns"));
    pool.ops = ops;
    let mut pool = NetnsPool::from_state_for_test(pool);

    pool.cleanup().await.unwrap();

    assert_eq!(delete_count.load(Ordering::SeqCst), 1);
    let pool = pool.inner.state.lock().await;
    assert!(!pool.active);
    assert!(pool.plain_queue.is_empty());
}

#[tokio::test]
async fn acquire_rejects_inactive_pool() {
    let mut pool = NetnsPoolState::inactive_for_test();
    pool.plain_queue.push_back(test_info("test-ns"));
    let mut pool = NetnsPool::from_state_for_test(pool);

    let err = pool.acquire().await.unwrap_err();

    assert!(matches!(err, NetworkError::PoolNotActive));
    {
        let pool = pool.inner.state.lock().await;
        assert_eq!(pool.plain_queue.len(), 1);
        assert!(pool.in_flight.is_empty());
    }
    pool.cleanup().await.unwrap();
}

#[tokio::test]
async fn acquire_requeues_namespace_when_checkout_detects_in_flight_duplicate() {
    let mut pool = NetnsPoolState::inactive_for_test();
    pool.active = true;
    pool.in_flight.insert("test-ns".into());
    pool.plain_queue.push_back(test_info("test-ns"));
    let mut pool = NetnsPool::from_state_for_test(pool);

    let err = pool.acquire().await.unwrap_err();

    assert!(matches!(err, NetworkError::InvalidLease(_)));
    {
        let mut pool = pool.inner.state.lock().await;
        assert_eq!(pool.plain_queue.len(), 1);
        assert_eq!(pool.plain_queue.front().unwrap().name(), "test-ns");
        assert!(pool.pending_plain.is_empty());
        assert_eq!(pool.next_ns_index, 0);

        pool.in_flight.clear();
    }
    pool.cleanup().await.unwrap();
}

#[tokio::test]
async fn proxy_acquire_requeues_namespace_when_checkout_detects_in_flight_duplicate() {
    let mut pool = NetnsPoolState::inactive_for_test();
    pool.active = true;
    pool.proxy_port = Some(8080);
    pool.in_flight.insert("test-ns".into());
    pool.proxy_queue.push_back(test_info("test-ns"));
    let mut pool = NetnsPool::from_state_for_test(pool);

    let err = pool.acquire().await.unwrap_err();

    assert!(matches!(err, NetworkError::InvalidLease(_)));
    {
        let mut pool = pool.inner.state.lock().await;
        assert!(pool.plain_queue.is_empty());
        assert_eq!(pool.proxy_queue.len(), 1);
        assert_eq!(pool.proxy_queue.front().unwrap().name(), "test-ns");
        assert!(pool.pending_proxy.is_empty());
        assert_eq!(pool.next_ns_index, 0);

        pool.in_flight.clear();
        pool.proxy_queue.clear();
    }
    pool.cleanup().await.unwrap();
}

#[tokio::test]
async fn release_keeps_lease_when_namespace_already_queued() {
    let mut pool = NetnsPoolState::inactive_for_test();
    pool.active = true;
    let info = test_info("test-ns");
    let mut lease = Some(pool.checkout(info.clone()).unwrap());
    pool.plain_queue.push_back(info);
    let mut pool = NetnsPool::from_state_for_test(pool);

    let err = pool.release(&mut lease).await.unwrap_err();

    assert!(matches!(err, NetworkError::InvalidLease(_)));
    assert!(lease.is_some());
    {
        let pool = pool.inner.state.lock().await;
        assert_eq!(pool.plain_queue.len(), 1);
        assert_eq!(pool.plain_queue.front().unwrap().name(), "test-ns");
    }

    let _ = lease.take().unwrap().into_info_for_test();
    {
        let mut pool = pool.inner.state.lock().await;
        pool.in_flight.clear();
        pool.plain_queue.clear();
    }
    pool.cleanup().await.unwrap();
}

#[tokio::test]
async fn proxy_release_keeps_lease_when_namespace_already_queued() {
    let mut pool = NetnsPoolState::inactive_for_test();
    pool.active = true;
    pool.proxy_port = Some(8080);
    let info = test_info("test-ns");
    let mut lease = Some(pool.checkout(info.clone()).unwrap());
    pool.proxy_queue.push_back(info);
    let mut pool = NetnsPool::from_state_for_test(pool);

    let err = pool.release(&mut lease).await.unwrap_err();

    assert!(matches!(err, NetworkError::InvalidLease(_)));
    assert!(lease.is_some());
    {
        let pool = pool.inner.state.lock().await;
        assert!(pool.plain_queue.is_empty());
        assert_eq!(pool.proxy_queue.len(), 1);
        assert_eq!(pool.proxy_queue.front().unwrap().name(), "test-ns");
    }

    let _ = lease.take().unwrap().into_info_for_test();
    {
        let mut pool = pool.inner.state.lock().await;
        pool.in_flight.clear();
        pool.proxy_queue.clear();
    }
    pool.cleanup().await.unwrap();
}

#[tokio::test]
async fn release_keeps_lease_on_wrong_pool_instance() {
    let mut pool = NetnsPoolState::inactive_for_test();
    pool.active = true;
    let info = test_info("test-ns");
    let mut lease = Some(NetnsLease::new(info, pool.instance_id + 1));
    let mut pool = NetnsPool::from_state_for_test(pool);

    let err = pool.release(&mut lease).await.unwrap_err();

    assert!(matches!(err, NetworkError::InvalidLease(_)));
    assert!(lease.is_some());
    let _ = lease.take().unwrap().into_info_for_test();

    pool.cleanup().await.unwrap();
}

#[tokio::test]
async fn release_keeps_lease_when_not_in_flight() {
    let mut pool = NetnsPoolState::inactive_for_test();
    pool.active = true;
    let info = test_info("test-ns");
    let mut lease = Some(NetnsLease::new(info, pool.instance_id));
    let mut pool = NetnsPool::from_state_for_test(pool);

    let err = pool.release(&mut lease).await.unwrap_err();

    assert!(matches!(err, NetworkError::InvalidLease(_)));
    assert!(lease.is_some());
    let _ = lease.take().unwrap().into_info_for_test();

    pool.cleanup().await.unwrap();
}
