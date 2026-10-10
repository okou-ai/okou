use std::time::{Duration, Instant};

use uuid::Uuid;

use crate::error::{self, Result};
use crate::{netlink, pool};

use super::create_timing::{NbdNetlinkConnectStage, NbdNetlinkConnectTiming};
use super::kernel::{CreateKernel, NativeKernel};

struct NetlinkCriticalSectionResult<T> {
    queue_duration: Duration,
    queue_success: bool,
    result: Result<T>,
}

pub(super) async fn run_netlink_critical_section<T>(
    operation: &'static str,
    f: impl FnOnce() -> T + Send + 'static,
) -> Result<T>
where
    T: Send + 'static,
{
    run_netlink_critical_section_with_queue_timing(operation, f)
        .await
        .result
}

async fn run_netlink_critical_section_with_queue_timing<T>(
    operation: &'static str,
    f: impl FnOnce() -> T + Send + 'static,
) -> NetlinkCriticalSectionResult<T>
where
    T: Send + 'static,
{
    let submitted_at = Instant::now();
    match tokio::task::spawn_blocking(move || {
        let queue_duration = submitted_at.elapsed();
        (queue_duration, f())
    })
    .await
    {
        Ok((queue_duration, value)) => NetlinkCriticalSectionResult {
            queue_duration,
            queue_success: true,
            result: Ok(value),
        },
        Err(e) if e.is_panic() => std::panic::resume_unwind(e.into_panic()),
        Err(e) => NetlinkCriticalSectionResult {
            queue_duration: submitted_at.elapsed(),
            queue_success: false,
            result: Err(error::NbdCowError::Io(std::io::Error::other(format!(
                "{operation} task was cancelled: {e}",
            )))),
        },
    }
}

struct DeferredLease {
    pool: pool::DevicePoolHandle,
    lease: Option<pool::DeviceLease>,
}

impl DeferredLease {
    fn new(pool: pool::DevicePoolHandle, lease: pool::DeviceLease) -> Self {
        Self {
            pool,
            lease: Some(lease),
        }
    }

    fn take(&mut self) -> Option<pool::DeviceLease> {
        self.lease.take()
    }
}

impl Drop for DeferredLease {
    fn drop(&mut self) {
        if let Some(lease) = self.lease.take() {
            self.pool.retire_uncertain_detached(lease);
        }
    }
}

pub(super) struct ConnectDeviceOutcome<K: CreateKernel = NativeKernel> {
    device_index: u32,
    lease: DeferredLease,
    result: Option<std::result::Result<netlink::ConnectDeviceSuccess, netlink::ConnectDeviceError>>,
    kernel: K,
    runtime: tokio::runtime::Handle,
}

pub(super) struct DeferredCreateCleanup {
    connected: ConnectedDevice,
    lease: DeferredLease,
}

impl DeferredCreateCleanup {
    pub(super) fn new(
        connected: ConnectedDevice,
        pool: pool::DevicePoolHandle,
        lease: Option<pool::DeviceLease>,
    ) -> Self {
        Self {
            connected,
            lease: DeferredLease { pool, lease },
        }
    }

    pub(super) fn dispatch(self, runtime: &tokio::runtime::Handle, kernel: impl CreateKernel) {
        // Either incomplete-create owner can be dropped on an async worker or
        // outside an entered runtime. Keep the lease with the blocking work;
        // if shutdown discards the closure, its non-blocking drop retires the
        // lease as uncertain without kernel I/O or recursive dispatch.
        runtime.spawn_blocking(move || {
            self.run_with(
                |index, id| kernel.ownership(index, id),
                |index| kernel.disconnect(index),
            );
        });
    }

    fn run_with(
        self,
        ownership: impl FnOnce(u32, Uuid) -> DeviceOwnership,
        disconnect: impl FnOnce(u32) -> Result<()>,
    ) {
        tracing::warn!(
            device_index = self.connected.index,
            "incomplete NBD create dropped; disconnecting owned device"
        );
        disconnect_connected_if_owned_with(self.connected, ownership, disconnect);
        drop(self.lease);
    }
}

pub(super) struct ConnectDeviceCriticalSectionResult<K: CreateKernel> {
    timing: NbdNetlinkConnectTiming,
    result: std::result::Result<ConnectDeviceOutcome<K>, netlink::ConnectDeviceError>,
}

impl<K: CreateKernel> ConnectDeviceCriticalSectionResult<K> {
    pub(super) fn into_parts(
        self,
    ) -> (
        NbdNetlinkConnectTiming,
        std::result::Result<ConnectDeviceOutcome<K>, netlink::ConnectDeviceError>,
    ) {
        (self.timing, self.result)
    }
}

#[cfg(test)]
impl ConnectDeviceOutcome {
    fn new(
        device_index: u32,
        lease: DeferredLease,
        result: std::result::Result<netlink::ConnectDeviceSuccess, netlink::ConnectDeviceError>,
    ) -> Self {
        Self::with_kernel(device_index, lease, result, NativeKernel)
    }
}

impl<K: CreateKernel> ConnectDeviceOutcome<K> {
    fn with_kernel(
        device_index: u32,
        lease: DeferredLease,
        result: std::result::Result<netlink::ConnectDeviceSuccess, netlink::ConnectDeviceError>,
        kernel: K,
    ) -> Self {
        Self {
            device_index,
            lease,
            result: Some(result),
            kernel,
            runtime: tokio::runtime::Handle::current(),
        }
    }

    pub(super) fn into_parts(
        mut self,
    ) -> std::result::Result<
        (
            pool::DeviceLease,
            std::result::Result<netlink::ConnectDeviceSuccess, netlink::ConnectDeviceError>,
        ),
        netlink::ConnectDeviceError,
    > {
        let result = match self.result.take() {
            Some(result) => result,
            None => Err(netlink::ConnectDeviceError::NotSent {
                source: error::NbdCowError::Io(std::io::Error::other(
                    "connect device outcome consumed twice",
                )),
            })?,
        };
        match self.lease.take() {
            Some(lease) => Ok((lease, result)),
            None => Err(netlink::ConnectDeviceError::NotSent {
                source: error::NbdCowError::Io(std::io::Error::other(
                    "connect device lease consumed twice",
                )),
            }),
        }
    }

    fn take_unobserved_cleanup(&mut self) -> Option<DeferredCreateCleanup> {
        let result = self.result.take()?;

        let connection_id = match result {
            Ok(success) => success.connection_id,
            Err(netlink::ConnectDeviceError::AmbiguousAfterSend { connection_id, .. }) => {
                connection_id
            }
            Err(
                netlink::ConnectDeviceError::NotSent { .. }
                | netlink::ConnectDeviceError::DefiniteAfterSend { .. },
            ) => return None,
        };

        Some(DeferredCreateCleanup::new(
            ConnectedDevice {
                index: self.device_index,
                connection_id,
            },
            self.lease.pool.clone(),
            self.lease.take(),
        ))
    }
}

impl<K: CreateKernel> Drop for ConnectDeviceOutcome<K> {
    fn drop(&mut self) {
        let Some(cleanup) = self.take_unobserved_cleanup() else {
            return;
        };
        cleanup.dispatch(&self.runtime, self.kernel.clone());
    }
}

pub(super) async fn connect_device_with_state_critical_section<K: CreateKernel>(
    device_index: u32,
    client_fds: Vec<std::os::fd::OwnedFd>,
    size: u64,
    block_size: u64,
    pool: pool::DevicePoolHandle,
    lease: pool::DeviceLease,
    kernel: K,
) -> ConnectDeviceCriticalSectionResult<K> {
    let deferred_lease = DeferredLease::new(pool, lease);
    let critical_section =
        run_netlink_critical_section_with_queue_timing("NBD connect", move || {
            let (result, timing) = kernel.connect(device_index, &client_fds, size, block_size);
            (
                ConnectDeviceOutcome::with_kernel(device_index, deferred_lease, result, kernel),
                timing,
            )
        })
        .await;

    let mut timing;
    let result = match critical_section.result {
        Ok((outcome, inner_timing)) => {
            timing = inner_timing;
            Ok(outcome)
        }
        Err(source) => {
            timing = NbdNetlinkConnectTiming::default();
            Err(netlink::ConnectDeviceError::NotSent { source })
        }
    };
    timing.record_stage_duration(
        NbdNetlinkConnectStage::BlockingTaskQueue,
        critical_section.queue_duration,
        critical_section.queue_success,
    );

    ConnectDeviceCriticalSectionResult { timing, result }
}

pub(super) struct OwnedDisconnectResultOutcome {
    device_index: u32,
    lease: DeferredLease,
    result: Option<Result<OwnedDisconnectState>>,
}

impl OwnedDisconnectResultOutcome {
    fn new(device_index: u32, lease: DeferredLease, result: Result<OwnedDisconnectState>) -> Self {
        Self {
            device_index,
            lease,
            result: Some(result),
        }
    }

    pub(super) fn into_parts(
        mut self,
    ) -> Result<(pool::DeviceLease, Result<OwnedDisconnectState>)> {
        let result = self.result.take().ok_or_else(|| {
            error::NbdCowError::Io(std::io::Error::other(
                "owned disconnect result outcome consumed twice",
            ))
        })?;
        let lease = self.lease.take().ok_or_else(|| {
            error::NbdCowError::Io(std::io::Error::other(
                "owned disconnect result outcome lease consumed twice",
            ))
        })?;
        Ok((lease, result))
    }
}

impl Drop for OwnedDisconnectResultOutcome {
    fn drop(&mut self) {
        if let Some(result) = self.result.as_ref() {
            observe_detached_disconnect_result(self.device_index, result);
        }
    }
}

pub(super) async fn disconnect_connected_if_owned_result_critical_section(
    connected: ConnectedDevice,
) -> Result<OwnedDisconnectState> {
    disconnect_connected_if_owned_result_with_kernel(connected, NativeKernel).await
}

pub(super) async fn disconnect_connected_if_owned_result_with_kernel(
    connected: ConnectedDevice,
    kernel: impl CreateKernel,
) -> Result<OwnedDisconnectState> {
    run_netlink_critical_section("owned NBD disconnect", move || {
        disconnect_connected_if_owned_result_with(
            connected,
            |index, id| kernel.ownership(index, id),
            |index| kernel.disconnect(index),
        )
    })
    .await?
}

pub(super) async fn disconnect_connected_if_owned_result_with_lease_critical_section(
    connected: ConnectedDevice,
    pool: pool::DevicePoolHandle,
    lease: pool::DeviceLease,
) -> Result<OwnedDisconnectResultOutcome> {
    disconnect_connected_if_owned_result_with_lease_and_kernel(connected, pool, lease, NativeKernel)
        .await
}

pub(super) async fn disconnect_connected_if_owned_result_with_lease_and_kernel(
    connected: ConnectedDevice,
    pool: pool::DevicePoolHandle,
    lease: pool::DeviceLease,
    kernel: impl CreateKernel,
) -> Result<OwnedDisconnectResultOutcome> {
    let deferred_lease = DeferredLease::new(pool, lease);
    run_netlink_critical_section("owned NBD disconnect", move || {
        OwnedDisconnectResultOutcome::new(
            connected.index,
            deferred_lease,
            disconnect_connected_if_owned_result_with(
                connected,
                |index, id| kernel.ownership(index, id),
                |index| kernel.disconnect(index),
            ),
        )
    })
    .await
}

/// Result of checking NBD device ownership via its sysfs backend identifier.
pub(super) enum DeviceOwnership {
    /// We own the device (the backend identifier matches our connection UUID).
    Ours,
    /// Another connection owns the device.
    Foreign,
    /// Cannot determine ownership (sysfs read failed).
    Unknown(std::io::Error),
}

#[derive(Clone, Copy)]
pub(super) struct ConnectedDevice {
    pub(super) index: u32,
    pub(super) connection_id: Uuid,
}

pub(super) enum OwnedDisconnectState {
    Disconnected,
    Foreign,
}

fn observe_detached_disconnect_result(device_index: u32, result: &Result<OwnedDisconnectState>) {
    match result {
        Err(e) => {
            tracing::warn!(
                device_index,
                error = %e,
                "detached NBD disconnect failed"
            );
        }
        Ok(OwnedDisconnectState::Foreign) => {
            tracing::warn!(
                device_index,
                "detached owned NBD disconnect skipped: device belongs to a different connection"
            );
        }
        Ok(OwnedDisconnectState::Disconnected) => {}
    }
}

pub(super) fn device_ownership(device_index: u32, connection_id: Uuid) -> DeviceOwnership {
    let backend_path = format!("/sys/block/nbd{device_index}/backend");
    match std::fs::read_to_string(&backend_path) {
        Ok(contents) => device_ownership_from_backend_contents(connection_id, &contents),
        Err(e) => DeviceOwnership::Unknown(e),
    }
}

fn device_ownership_from_backend_contents(connection_id: Uuid, contents: &str) -> DeviceOwnership {
    if contents.trim() == connection_id.to_string() {
        DeviceOwnership::Ours
    } else {
        DeviceOwnership::Foreign
    }
}

fn disconnect_connected_if_owned_result_with(
    connected: ConnectedDevice,
    ownership: impl FnOnce(u32, Uuid) -> DeviceOwnership,
    disconnect: impl FnOnce(u32) -> Result<()>,
) -> Result<OwnedDisconnectState> {
    match ownership(connected.index, connected.connection_id) {
        DeviceOwnership::Ours => {
            disconnect(connected.index)?;
            Ok(OwnedDisconnectState::Disconnected)
        }
        DeviceOwnership::Foreign => Ok(OwnedDisconnectState::Foreign),
        DeviceOwnership::Unknown(err) => Err(error::NbdCowError::Io(std::io::Error::new(
            err.kind(),
            format!(
                "cannot read NBD device ownership for nbd{}: {err}",
                connected.index
            ),
        ))),
    }
}

fn disconnect_connected_if_owned_with(
    connected: ConnectedDevice,
    ownership: impl FnOnce(u32, Uuid) -> DeviceOwnership,
    disconnect: impl FnOnce(u32) -> Result<()>,
) -> bool {
    match ownership(connected.index, connected.connection_id) {
        DeviceOwnership::Ours => {
            if let Err(e) = disconnect(connected.index) {
                tracing::warn!(
                    device_index = connected.index,
                    error = %e,
                    "NBD disconnect failed during cancelled create"
                );
                false
            } else {
                true
            }
        }
        DeviceOwnership::Foreign => {
            tracing::warn!(
                device_index = connected.index,
                "skipping cancelled-create disconnect: device belongs to a different connection"
            );
            false
        }
        DeviceOwnership::Unknown(err) => {
            tracing::warn!(
                device_index = connected.index,
                error = %err,
                "skipping cancelled-create disconnect: cannot read device backend identity"
            );
            false
        }
    }
}

/// Check if a TID belongs to our process by probing `/proc/self/task/{tid}`.
///
/// The kernel NBD driver records the connecting thread's TID (not TGID) in
/// sysfs. In a multi-threaded tokio runtime the connecting worker thread has
/// a TID different from the process TGID returned by `std::process::id()`.
/// This function handles both cases: TID == TGID (main thread) and
/// TID != TGID (worker threads).
pub fn is_our_thread(tid: u32) -> bool {
    tid == std::process::id() || std::path::Path::new(&format!("/proc/self/task/{tid}")).exists()
}

#[cfg(test)]
mod tests {
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

    async fn acquired_test_lease() -> (pool::DevicePoolHandle, pool::DeviceLease, tempfile::TempDir)
    {
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
                source: error::NbdCowError::Io(std::io::Error::other(
                    "connect completion unavailable",
                )),
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
}
