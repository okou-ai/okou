mod cancellation;

use super::*;
use tracing::Level;
use tracing_subscriber::prelude::*;
use tracing_test_support::{CapturedEvent, CapturedEvents};

const TEST_DEVICE_INDEX: u32 = 0;

const CONNECT_RESULT_DROPPED_MESSAGE: &str =
    "incomplete NBD create dropped; disconnecting owned device";

fn test_connection_id() -> Uuid {
    Uuid::from_u128(42)
}

async fn acquired_test_lease() -> (pool::DevicePoolHandle, pool::DeviceLease, tempfile::TempDir) {
    let lock_dir = tempfile::tempdir().unwrap();
    let pool = pool::DevicePoolHandle::new_one_device_for_test(
        pool::DevicePoolConfig {
            cooldown: Duration::MAX,
        },
        lock_dir.path(),
    );
    let (lease, _, _) = pool.acquire().await.unwrap().into_parts();
    assert_eq!(lease.index(), TEST_DEVICE_INDEX);
    (pool, lease, lock_dir)
}

fn capture_events<T>(action: impl FnOnce() -> T) -> (T, CapturedEvents) {
    let captured = CapturedEvents::default();
    let subscriber = tracing_subscriber::registry().with(captured.clone());
    let result = tracing::subscriber::with_default(subscriber, action);
    (result, captured)
}

fn event_with_message(captured: &CapturedEvents, message: &str) -> CapturedEvent {
    let entries = captured.entries();
    let mut matching = entries
        .iter()
        .filter(|event| event.fields.get("message").map(String::as_str) == Some(message));
    let event = matching.next().expect("expected tracing event");
    assert!(
        matching.next().is_none(),
        "duplicate tracing events: {entries:#?}"
    );
    event.clone()
}

fn assert_no_detached_disconnect_events(captured: &CapturedEvents) {
    let entries = captured.entries();
    assert!(
        entries.iter().all(|event| {
            !event
                .fields
                .get("message")
                .is_some_and(|message| message.contains("detached") && message.contains("NBD"))
        }),
        "unexpected detached disconnect events: {entries:#?}"
    );
}

fn assert_no_event_with_message(captured: &CapturedEvents, message: &str) {
    let entries = captured.entries();
    assert!(
        entries
            .iter()
            .all(|event| event.fields.get("message").map(String::as_str) != Some(message)),
        "unexpected tracing event: {entries:#?}"
    );
}

async fn assert_single_lease_returned(pool: &pool::DevicePoolHandle) {
    let snapshot = pool.snapshot().await;
    assert!(snapshot.in_flight.is_empty());
    assert_eq!(snapshot.cooldown, vec![TEST_DEVICE_INDEX]);
    pool.cleanup().await;
}

async fn assert_connect_cleanup(
    result: std::result::Result<netlink::ConnectDeviceSuccess, netlink::ConnectDeviceError>,
    expected_connection_id: Uuid,
) {
    let (pool, lease, _lock_dir) = acquired_test_lease().await;
    let mut outcome = ConnectDeviceOutcome::new(
        TEST_DEVICE_INDEX,
        DeferredLease::new(pool.clone(), lease),
        result,
    );
    let ownership_calls = std::cell::Cell::new(0);
    let disconnect_calls = std::cell::Cell::new(0);

    let ((), captured) = capture_events(|| {
        outcome.take_unobserved_cleanup().unwrap().run_with(
            |index, connection_id| {
                ownership_calls.set(ownership_calls.get() + 1);
                assert_eq!(index, TEST_DEVICE_INDEX);
                assert_eq!(connection_id, expected_connection_id);
                DeviceOwnership::Ours
            },
            |index| {
                disconnect_calls.set(disconnect_calls.get() + 1);
                assert_eq!(index, TEST_DEVICE_INDEX);
                Ok(())
            },
        );
        drop(outcome);
    });

    assert_eq!(ownership_calls.get(), 1);
    assert_eq!(disconnect_calls.get(), 1);
    let event = event_with_message(&captured, CONNECT_RESULT_DROPPED_MESSAGE);
    assert_eq!(event.level, Level::WARN);
    assert_eq!(
        event.fields.get("device_index").map(String::as_str),
        Some("0")
    );
    assert_single_lease_returned(&pool).await;
}

async fn assert_connect_cleanup_skipped(
    result: std::result::Result<netlink::ConnectDeviceSuccess, netlink::ConnectDeviceError>,
) {
    let (pool, lease, _lock_dir) = acquired_test_lease().await;
    let mut outcome = ConnectDeviceOutcome::new(
        TEST_DEVICE_INDEX,
        DeferredLease::new(pool.clone(), lease),
        result,
    );

    let ((), captured) = capture_events(|| {
        assert!(outcome.take_unobserved_cleanup().is_none());
        drop(outcome);
    });

    assert_no_event_with_message(&captured, CONNECT_RESULT_DROPPED_MESSAGE);
    assert_single_lease_returned(&pool).await;
}

#[tokio::test(flavor = "current_thread")]
async fn dropped_successful_and_ambiguous_connects_cleanup_exact_owner() {
    let successful_connection_id = Uuid::from_u128(43);
    assert_connect_cleanup(
        Ok(netlink::ConnectDeviceSuccess {
            connection_id: successful_connection_id,
        }),
        successful_connection_id,
    )
    .await;

    let ambiguous_connection_id = Uuid::from_u128(44);
    assert_connect_cleanup(
        Err(netlink::ConnectDeviceError::AmbiguousAfterSend {
            connection_id: ambiguous_connection_id,
            source: error::NbdCowError::Io(std::io::Error::other("connect completion unavailable")),
        }),
        ambiguous_connection_id,
    )
    .await;
}

#[tokio::test(flavor = "current_thread")]
async fn dropped_not_sent_and_definite_connect_failures_skip_cleanup() {
    assert_connect_cleanup_skipped(Err(netlink::ConnectDeviceError::NotSent {
        source: error::NbdCowError::Io(std::io::Error::other("connect was not sent")),
    }))
    .await;

    assert_connect_cleanup_skipped(Err(netlink::ConnectDeviceError::DefiniteAfterSend {
        source: error::NbdCowError::NetlinkErrno {
            errno: libc::EINVAL,
            message: "test connect rejected".to_string(),
        },
    }))
    .await;
}

#[tokio::test(flavor = "current_thread")]
async fn consumed_connect_outcome_returns_lease_without_drop_cleanup() {
    let (pool, lease, _lock_dir) = acquired_test_lease().await;
    let connection_id = test_connection_id();
    let outcome = ConnectDeviceOutcome::new(
        TEST_DEVICE_INDEX,
        DeferredLease::new(pool.clone(), lease),
        Ok(netlink::ConnectDeviceSuccess { connection_id }),
    );

    let (parts, captured) = capture_events(|| outcome.into_parts().unwrap());

    assert_no_event_with_message(&captured, CONNECT_RESULT_DROPPED_MESSAGE);
    let (lease, result) = parts;
    assert_eq!(lease.index(), TEST_DEVICE_INDEX);
    assert_eq!(result.unwrap().connection_id, connection_id);
    pool.release_clean(lease).await;
    assert_single_lease_returned(&pool).await;
}

#[tokio::test(flavor = "current_thread")]
async fn dropped_owned_disconnect_error_is_observed() {
    let (pool, lease, _lock_dir) = acquired_test_lease().await;
    let outcome = OwnedDisconnectResultOutcome::new(
        TEST_DEVICE_INDEX,
        DeferredLease::new(pool.clone(), lease),
        Err(error::NbdCowError::Io(std::io::Error::other(
            "owned disconnect failed",
        ))),
    );

    let ((), captured) = capture_events(|| drop(outcome));

    let event = event_with_message(&captured, "detached NBD disconnect failed");
    assert_eq!(event.level, Level::WARN);
    assert_eq!(
        event.fields.get("device_index").map(String::as_str),
        Some("0")
    );
    assert_eq!(
        event.fields.get("error").map(String::as_str),
        Some("I/O error: owned disconnect failed")
    );
    assert_single_lease_returned(&pool).await;
}

#[tokio::test(flavor = "current_thread")]
async fn dropped_owned_foreign_disconnect_is_observed() {
    let (pool, lease, _lock_dir) = acquired_test_lease().await;
    let outcome = OwnedDisconnectResultOutcome::new(
        TEST_DEVICE_INDEX,
        DeferredLease::new(pool.clone(), lease),
        Ok(OwnedDisconnectState::Foreign),
    );

    let ((), captured) = capture_events(|| drop(outcome));

    let event = event_with_message(
        &captured,
        "detached owned NBD disconnect skipped: device belongs to a different connection",
    );
    assert_eq!(event.level, Level::WARN);
    assert_eq!(
        event.fields.get("device_index").map(String::as_str),
        Some("0")
    );
    assert!(!event.fields.contains_key("foreign_pid"));
    assert_single_lease_returned(&pool).await;
}

#[tokio::test(flavor = "current_thread")]
async fn successful_and_consumed_disconnect_outcomes_are_not_observed() {
    let (owned_pool, owned_lease, _owned_lock_dir) = acquired_test_lease().await;
    let (consumed_owned_pool, consumed_owned_lease, _consumed_owned_lock_dir) =
        acquired_test_lease().await;

    let (consumed, captured) = capture_events(|| {
        drop(OwnedDisconnectResultOutcome::new(
            TEST_DEVICE_INDEX,
            DeferredLease::new(owned_pool.clone(), owned_lease),
            Ok(OwnedDisconnectState::Disconnected),
        ));

        OwnedDisconnectResultOutcome::new(
            TEST_DEVICE_INDEX,
            DeferredLease::new(consumed_owned_pool.clone(), consumed_owned_lease),
            Ok(OwnedDisconnectState::Foreign),
        )
        .into_parts()
        .unwrap()
    });

    assert_no_detached_disconnect_events(&captured);
    let (owned_lease, owned_result) = consumed;
    assert!(matches!(owned_result, Ok(OwnedDisconnectState::Foreign)));
    consumed_owned_pool.release_clean(owned_lease).await;

    assert_single_lease_returned(&owned_pool).await;
    assert_single_lease_returned(&consumed_owned_pool).await;
}

#[tokio::test(flavor = "current_thread")]
async fn netlink_critical_section_current_thread_runtime_runs() {
    let value = run_netlink_critical_section("test netlink operation", || "connected")
        .await
        .unwrap();

    assert_eq!(value, "connected");
}

#[test]
fn timed_netlink_critical_section_records_queued_start() {
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(1)
        .max_blocking_threads(1)
        .enable_time()
        .build()
        .unwrap();

    runtime.block_on(async {
        let (blocker_started_tx, blocker_started_rx) = tokio::sync::oneshot::channel();
        let (release_blocker_tx, release_blocker_rx) = std::sync::mpsc::channel();
        let blocker = tokio::task::spawn_blocking(move || {
            let _ = blocker_started_tx.send(());
            release_blocker_rx.recv().unwrap();
        });
        blocker_started_rx.await.unwrap();

        let mut future = Box::pin(run_netlink_critical_section_with_queue_timing(
            "test netlink operation",
            || "connected",
        ));
        let waker = std::task::Waker::noop();
        let mut cx = std::task::Context::from_waker(waker);
        assert!(matches!(
            future.as_mut().poll(&mut cx),
            std::task::Poll::Pending
        ));

        release_blocker_tx.send(()).unwrap();
        blocker.await.unwrap();
        let outcome = future.await;

        assert!(outcome.queue_success);
        assert!(outcome.queue_duration > Duration::ZERO);
        assert_eq!(outcome.result.unwrap(), "connected");
    });
}

#[tokio::test(flavor = "multi_thread")]
async fn netlink_critical_section_multi_thread_runtime_runs() {
    let value = run_netlink_critical_section("test netlink operation", || "connected")
        .await
        .unwrap();

    assert_eq!(value, "connected");
}

#[test]
fn netlink_critical_section_block_on_multi_thread_runtime_runs() {
    let runtime = tokio::runtime::Runtime::new().unwrap();
    let value = runtime.block_on(async {
        run_netlink_critical_section("test netlink operation", || "connected")
            .await
            .unwrap()
    });

    assert_eq!(value, "connected");
}

#[test]
fn netlink_critical_section_entered_multi_thread_runtime_runs() {
    let runtime = tokio::runtime::Runtime::new().unwrap();
    let _guard = runtime.enter();
    let value = runtime.block_on(async {
        run_netlink_critical_section("test netlink operation", || "connected")
            .await
            .unwrap()
    });

    assert_eq!(value, "connected");
}

#[test]
fn netlink_critical_section_local_set_multi_thread_runtime_runs() {
    let runtime = tokio::runtime::Runtime::new().unwrap();
    let local = tokio::task::LocalSet::new();
    let value = local.block_on(&runtime, async {
        run_netlink_critical_section("test netlink operation", || "connected")
            .await
            .unwrap()
    });

    assert_eq!(value, "connected");
}

#[tokio::test(flavor = "multi_thread")]
async fn netlink_critical_section_continues_after_awaiter_abort() {
    let (started_tx, started_rx) = tokio::sync::oneshot::channel();
    let (done_tx, done_rx) = tokio::sync::oneshot::channel();
    let (finish_tx, finish_rx) = std::sync::mpsc::channel();

    let handle = tokio::spawn(async move {
        run_netlink_critical_section("test netlink operation", move || {
            let _ = started_tx.send(());
            finish_rx.recv().expect("finish signal");
            let _ = done_tx.send(());
        })
        .await
        .unwrap();
    });

    started_rx.await.unwrap();
    handle.abort();
    finish_tx.send(()).unwrap();

    tokio::time::timeout(std::time::Duration::from_secs(1), done_rx)
        .await
        .unwrap()
        .unwrap();
}

#[test]
fn netlink_critical_section_queued_task_drops_unobserved_output() {
    struct DropNotify(Option<std::sync::mpsc::Sender<()>>);

    impl Drop for DropNotify {
        fn drop(&mut self) {
            if let Some(tx) = self.0.take() {
                let _ = tx.send(());
            }
        }
    }

    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(1)
        .max_blocking_threads(1)
        .enable_time()
        .build()
        .unwrap();

    runtime.block_on(async {
        let (blocker_started_tx, blocker_started_rx) = tokio::sync::oneshot::channel();
        let (release_blocker_tx, release_blocker_rx) = std::sync::mpsc::channel();
        let blocker = tokio::task::spawn_blocking(move || {
            let _ = blocker_started_tx.send(());
            release_blocker_rx.recv().unwrap();
        });
        blocker_started_rx.await.unwrap();

        let (dropped_tx, dropped_rx) = std::sync::mpsc::channel();
        let mut future = Box::pin(run_netlink_critical_section(
            "test netlink operation",
            move || DropNotify(Some(dropped_tx)),
        ));
        let waker = std::task::Waker::noop();
        let mut cx = std::task::Context::from_waker(waker);
        assert!(matches!(
            future.as_mut().poll(&mut cx),
            std::task::Poll::Pending
        ));
        drop(future);

        release_blocker_tx.send(()).unwrap();
        blocker.await.unwrap();

        tokio::task::spawn_blocking(move || {
            dropped_rx
                .recv_timeout(std::time::Duration::from_secs(1))
                .unwrap()
        })
        .await
        .unwrap();
    });
}

#[test]
fn device_ownership_matches_backend_identity() {
    let connection_id = test_connection_id();
    let ownership =
        device_ownership_from_backend_contents(connection_id, &format!("{connection_id}\n"));

    assert!(matches!(ownership, DeviceOwnership::Ours));
}

#[test]
fn device_ownership_rejects_empty_or_different_backend_identity() {
    for contents in ["", "different\n", "00000000-0000-0000-0000-000000000000\n"] {
        let ownership = device_ownership_from_backend_contents(test_connection_id(), contents);

        assert!(matches!(ownership, DeviceOwnership::Foreign));
    }
}

#[test]
fn disconnect_connected_if_owned_disconnects_matching_owner() {
    let calls = std::cell::Cell::new(0);
    let connection_id = test_connection_id();
    let connected = ConnectedDevice {
        index: 7,
        connection_id,
    };

    let disconnected = disconnect_connected_if_owned_with(
        connected,
        |index, observed_connection_id| {
            assert_eq!(index, 7);
            assert_eq!(observed_connection_id, connection_id);
            DeviceOwnership::Ours
        },
        |index| {
            assert_eq!(index, 7);
            calls.set(calls.get() + 1);
            Ok(())
        },
    );

    assert!(disconnected);
    assert_eq!(calls.get(), 1);
}

#[test]
fn disconnect_connected_if_owned_result_disconnects_matching_owner() {
    let calls = std::cell::Cell::new(0);
    let connection_id = test_connection_id();
    let connected = ConnectedDevice {
        index: 7,
        connection_id,
    };

    let result = disconnect_connected_if_owned_result_with(
        connected,
        |index, observed_connection_id| {
            assert_eq!(index, 7);
            assert_eq!(observed_connection_id, connection_id);
            DeviceOwnership::Ours
        },
        |index| {
            assert_eq!(index, 7);
            calls.set(calls.get() + 1);
            Ok(())
        },
    )
    .expect("matching owner should disconnect");

    assert!(matches!(result, OwnedDisconnectState::Disconnected));
    assert_eq!(calls.get(), 1);
}

#[test]
fn disconnect_connected_if_owned_skips_foreign_owner() {
    let connection_id = test_connection_id();
    let connected = ConnectedDevice {
        index: 7,
        connection_id,
    };

    let disconnected = disconnect_connected_if_owned_with(
        connected,
        |index, observed_connection_id| {
            assert_eq!(index, 7);
            assert_eq!(observed_connection_id, connection_id);
            DeviceOwnership::Foreign
        },
        |_| panic!("foreign device must not be disconnected"),
    );

    assert!(!disconnected);
}

#[test]
fn disconnect_connected_if_owned_result_skips_foreign_owner() {
    let connection_id = test_connection_id();
    let connected = ConnectedDevice {
        index: 7,
        connection_id,
    };

    let result = disconnect_connected_if_owned_result_with(
        connected,
        |index, observed_connection_id| {
            assert_eq!(index, 7);
            assert_eq!(observed_connection_id, connection_id);
            DeviceOwnership::Foreign
        },
        |_| panic!("foreign device must not be disconnected"),
    )
    .expect("foreign owner should be reported");

    assert!(matches!(result, OwnedDisconnectState::Foreign));
}

#[test]
fn disconnect_connected_if_owned_skips_unknown_owner() {
    let connection_id = test_connection_id();
    let connected = ConnectedDevice {
        index: 7,
        connection_id,
    };

    let disconnected = disconnect_connected_if_owned_with(
        connected,
        |index, observed_connection_id| {
            assert_eq!(index, 7);
            assert_eq!(observed_connection_id, connection_id);
            DeviceOwnership::Unknown(std::io::Error::other("sysfs unavailable"))
        },
        |_| panic!("unknown ownership must not be disconnected"),
    );

    assert!(!disconnected);
}

#[test]
fn disconnect_connected_if_owned_result_errors_on_unknown_owner() {
    let connection_id = test_connection_id();
    let connected = ConnectedDevice {
        index: 7,
        connection_id,
    };

    let result = disconnect_connected_if_owned_result_with(
        connected,
        |index, observed_connection_id| {
            assert_eq!(index, 7);
            assert_eq!(observed_connection_id, connection_id);
            DeviceOwnership::Unknown(std::io::Error::other("sysfs unavailable"))
        },
        |_| panic!("unknown ownership must not be disconnected"),
    );

    match result {
        Err(error::NbdCowError::Io(e)) => {
            assert!(e.to_string().contains("cannot read NBD device ownership"));
        }
        Err(e) => panic!("expected I/O error, got {e}"),
        Ok(_) => panic!("unknown owner should fail shutdown ownership check"),
    }
}

#[test]
fn disconnect_connected_if_owned_reports_disconnect_error() {
    let connected = ConnectedDevice {
        index: 7,
        connection_id: test_connection_id(),
    };

    let disconnected = disconnect_connected_if_owned_with(
        connected,
        |_, _| DeviceOwnership::Ours,
        |_| {
            Err(error::NbdCowError::Io(std::io::Error::other(
                "disconnect failed",
            )))
        },
    );

    assert!(!disconnected);
}

/// Verify is_our_thread correctly identifies the main thread (TID == TGID).
#[test]
fn is_our_thread_main_thread() {
    assert!(is_our_thread(std::process::id()));
}

/// Verify is_our_thread identifies a spawned thread's TID as ours.
/// This exercises the /proc/self/task/{tid} path used by tokio workers.
#[test]
fn is_our_thread_worker_thread() {
    // Use a running thread to ensure /proc/self/task/{tid} exists.
    let (tx, rx) = std::sync::mpsc::channel();
    let handle = std::thread::spawn(move || {
        let tid = unsafe { libc::gettid() } as u32;
        tx.send(tid).unwrap();
        // Keep thread alive until main reads the TID and checks it.
        std::thread::park();
        tid
    });
    let worker_tid = rx.recv().unwrap();
    assert_ne!(
        worker_tid,
        std::process::id(),
        "worker TID should differ from TGID"
    );
    assert!(
        is_our_thread(worker_tid),
        "worker thread TID should be recognized as ours"
    );
    handle.thread().unpark();
    handle.join().unwrap();
}

/// Verify is_our_thread rejects a TID that cannot exist.
#[test]
fn is_our_thread_nonexistent_tid() {
    assert!(!is_our_thread(u32::MAX));
}
