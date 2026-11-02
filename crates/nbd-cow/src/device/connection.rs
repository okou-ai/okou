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
mod tests;
