use std::os::fd::OwnedFd;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use crate::error::{self, Result};
use crate::{
    BLOCK_SIZE, DEFAULT_FLUSH_THRESHOLD, NUM_CONNECTIONS, cow, cow_io, netlink, pool, server,
};
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use super::NbdCowDevice;
use super::connection::{
    ConnectedDevice, DeferredCreateCleanup, OwnedDisconnectState,
    connect_device_with_state_critical_section, disconnect_connected_if_owned_result_with_kernel,
    disconnect_connected_if_owned_result_with_lease_and_kernel,
};
use super::create_timing::{
    NbdCowCreateObserver, NbdCowCreateStage, NbdCowCreateTiming, NbdNetlinkConnectTiming,
};
use super::kernel::{CreateKernel, NativeKernel};

const MAX_SIZE_RETRIES: u32 = 5;
const MAX_EBUSY_RETRIES: u32 = 16;
const SIZE_RETRY_DELAY: Duration = Duration::from_millis(200);

struct CreateAttemptGuard<K: CreateKernel = NativeKernel> {
    pool: pool::DevicePoolHandle,
    device_index: u32,
    lease: Option<pool::DeviceLease>,
    shutdown: CancellationToken,
    server_handles: Vec<JoinHandle<()>>,
    connected: Option<ConnectedDevice>,
    kernel: K,
    runtime: tokio::runtime::Handle,
}

#[derive(Clone, Copy)]
enum CreateDisconnectCleanupMode {
    AmbiguousConnect,
    SizeRetry,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum CreateDisconnectStatus {
    Disconnected,
    Uncertain,
}

struct ConnectAttemptResult {
    timing: NbdNetlinkConnectTiming,
    result: std::result::Result<netlink::ConnectDeviceSuccess, netlink::ConnectDeviceError>,
}

impl CreateDisconnectStatus {
    fn from_owned_result(result: &Result<OwnedDisconnectState>) -> Self {
        match result {
            Ok(OwnedDisconnectState::Disconnected) => Self::Disconnected,
            // In create cleanup, a foreign owner means this attempt did not
            // prove its provisional device was disconnected.
            Ok(OwnedDisconnectState::Foreign) | Err(_) => Self::Uncertain,
        }
    }

    fn is_clean(self) -> bool {
        matches!(self, Self::Disconnected)
    }
}

struct CreateContext<'a, 'observer, K: CreateKernel> {
    device_pool: &'a pool::DevicePoolHandle,
    cow_file: &'a Path,
    cow: cow_io::CowIo,
    size: u64,
    timing: &'a mut NbdCowCreateTiming<'observer>,
    kernel: K,
}

impl<'a, 'observer, K: CreateKernel> CreateContext<'a, 'observer, K> {
    fn new(
        device_pool: &'a pool::DevicePoolHandle,
        cow_file: &'a Path,
        cow: cow_io::CowIo,
        size: u64,
        timing: &'a mut NbdCowCreateTiming<'observer>,
        kernel: K,
    ) -> Self {
        Self {
            device_pool,
            cow_file,
            cow,
            size,
            timing,
            kernel,
        }
    }

    async fn create_with_size_retries(&mut self) -> Result<(NbdCowDevice, pool::DeviceLease)> {
        let mut last_err_idx: u32 = 0;

        for size_attempt in 0..=MAX_SIZE_RETRIES {
            let attempt = self.acquire_connected_attempt().await?;
            let device_index = attempt.device_index();

            let verify_started_at = Instant::now();
            let size_matches = self.kernel.verify_size(device_index, self.size).await;
            self.timing.record_stage(
                NbdCowCreateStage::SizeVerify,
                verify_started_at,
                size_matches,
            );
            if size_matches {
                return attempt.into_device(self.cow_file, self.cow.clone());
            }

            tracing::info!(
                device_index,
                attempt = size_attempt + 1,
                "device size 0 after connect, disconnecting and retrying"
            );
            let cleanup_started_at = Instant::now();
            attempt.disconnect_and_release().await;
            self.timing
                .record_stage(NbdCowCreateStage::RetryCleanup, cleanup_started_at, true);
            last_err_idx = device_index;

            if size_attempt < MAX_SIZE_RETRIES {
                self.timing.record_size_zero_retry();
                let delay_started_at = Instant::now();
                tokio::time::sleep(SIZE_RETRY_DELAY).await;
                self.timing
                    .record_stage(NbdCowCreateStage::RetryDelay, delay_started_at, true);
            }
        }

        Err(error::NbdCowError::Io(std::io::Error::other(format!(
            "device size stuck at 0 after {MAX_SIZE_RETRIES} connect retries \
             on nbd{last_err_idx} — kernel may not have finished releasing \
             the previous connection",
        ))))
    }

    async fn acquire_connected_attempt(&mut self) -> Result<CreateAttemptGuard<K>> {
        let mut ebusy_count: u32 = 0;

        loop {
            let acquire_started_at = Instant::now();
            let acquisition = self.device_pool.acquire().await;
            self.timing.record_stage(
                NbdCowCreateStage::DeviceAcquire,
                acquire_started_at,
                acquisition.is_ok(),
            );
            let acquisition = acquisition?;
            let (lease, source, scan_duration) = acquisition.into_parts();
            self.timing.record_acquisition(source, scan_duration);
            let mut attempt = CreateAttemptGuard::with_kernel(
                self.device_pool.clone(),
                lease,
                self.kernel.clone(),
            );
            let device_index = attempt.device_index();

            let setup_started_at = Instant::now();
            let setup_result = self.setup_dispatch_servers(&mut attempt);
            self.timing.record_stage(
                NbdCowCreateStage::DispatchSetup,
                setup_started_at,
                setup_result.is_ok(),
            );
            let client_fds = match setup_result {
                Ok(client_fds) => client_fds,
                Err(e) => {
                    // Release device back — connect was never attempted, device
                    // is still free in kernel. No cooldown needed but release()
                    // adds one defensively.
                    attempt.release_clean().await;
                    return Err(e);
                }
            };

            let connect_started_at = Instant::now();
            let connect_attempt = self.connect_attempt(&mut attempt, client_fds).await;
            // End the existing parent before merging child timing so its
            // before/after boundary remains comparable.
            self.timing.record_stage(
                NbdCowCreateStage::NetlinkConnect,
                connect_started_at,
                connect_attempt.result.is_ok(),
            );
            self.timing
                .record_netlink_connect_timing(connect_attempt.timing);
            let connect_result = connect_attempt.result;
            match connect_result {
                Ok(connected) => {
                    attempt.mark_connected(connected.connection_id);
                    return Ok(attempt);
                }
                Err(netlink::ConnectDeviceError::DefiniteAfterSend {
                    source: error::NbdCowError::NetlinkErrno { errno, .. },
                }) if errno == libc::EBUSY => {
                    ebusy_count += 1;
                    tracing::info!(
                        device_index,
                        ebusy_count,
                        "EBUSY on connect, trying next device"
                    );
                    if ebusy_count > MAX_EBUSY_RETRIES {
                        let cleanup_started_at = Instant::now();
                        attempt.discard().await;
                        self.timing.record_stage(
                            NbdCowCreateStage::RetryCleanup,
                            cleanup_started_at,
                            true,
                        );
                        return Err(error::NbdCowError::NoFreeDevice);
                    }
                    self.timing.record_ebusy_retry();
                    // Device is owned by another process or otherwise busy.
                    // Stop tracking without cooldown; a future demand scan
                    // will rediscover it once it frees.
                    let cleanup_started_at = Instant::now();
                    attempt.discard().await;
                    self.timing.record_stage(
                        NbdCowCreateStage::RetryCleanup,
                        cleanup_started_at,
                        true,
                    );
                }
                Err(netlink::ConnectDeviceError::AmbiguousAfterSend {
                    connection_id,
                    source,
                }) => {
                    // The kernel may have accepted NBD_CMD_CONNECT even
                    // though userspace failed while observing completion.
                    // Record a provisional candidate so cleanup can
                    // disconnect only if sysfs still proves we own it.
                    attempt.mark_connected(connection_id);
                    attempt.disconnect_owned_and_release().await;
                    return Err(source);
                }
                Err(connect_error) => {
                    // Connect failed with non-EBUSY error. Device may be in
                    // an unknown kernel state — retire with cooldown so it
                    // gets re-validated before reuse.
                    attempt.retire_uncertain().await;
                    return Err(connect_error.into_source());
                }
            }
        }
    }

    fn setup_dispatch_servers(&self, attempt: &mut CreateAttemptGuard<K>) -> Result<Vec<OwnedFd>> {
        let mut client_fds = Vec::with_capacity(NUM_CONNECTIONS);

        for _ in 0..NUM_CONNECTIONS {
            let (client_fd, server_fd) = netlink::create_socketpair()?;
            client_fds.push(client_fd);

            let cow = self.cow.clone();
            let token = attempt.shutdown_token();
            let handle = tokio::spawn(async move {
                if let Err(e) = server::dispatch(server_fd, cow, token).await {
                    tracing::error!("NBD dispatch error: {e}");
                }
            });
            attempt.push_server_handle(handle);
        }

        Ok(client_fds)
    }

    async fn connect_attempt(
        &mut self,
        attempt: &mut CreateAttemptGuard<K>,
        client_fds: Vec<OwnedFd>,
    ) -> ConnectAttemptResult {
        let device_index = attempt.device_index();
        let Some(lease) = attempt.take_lease() else {
            return ConnectAttemptResult {
                timing: NbdNetlinkConnectTiming::default(),
                result: Err(netlink::ConnectDeviceError::NotSent {
                    source: error::NbdCowError::Io(std::io::Error::other(
                        "pool lease missing during NBD connect",
                    )),
                }),
            };
        };

        let critical_section = connect_device_with_state_critical_section(
            device_index,
            client_fds,
            self.size,
            BLOCK_SIZE as u64,
            self.device_pool.clone(),
            lease,
            self.kernel.clone(),
        )
        .await;
        let (timing, critical_result) = critical_section.into_parts();
        let result = match critical_result {
            Ok(outcome) => match outcome.into_parts() {
                Ok((lease, result)) => {
                    attempt.restore_lease(lease);
                    result
                }
                Err(e) => Err(e),
            },
            Err(e) => Err(e),
        };

        ConnectAttemptResult { timing, result }
    }
}

#[cfg(test)]
impl CreateAttemptGuard {
    fn new(pool: pool::DevicePoolHandle, lease: pool::DeviceLease) -> Self {
        Self::with_kernel(pool, lease, NativeKernel)
    }
}

impl<K: CreateKernel> CreateAttemptGuard<K> {
    fn with_kernel(pool: pool::DevicePoolHandle, lease: pool::DeviceLease, kernel: K) -> Self {
        let device_index = lease.index();
        Self {
            pool,
            device_index,
            lease: Some(lease),
            shutdown: CancellationToken::new(),
            server_handles: Vec::with_capacity(NUM_CONNECTIONS),
            connected: None,
            kernel,
            runtime: tokio::runtime::Handle::current(),
        }
    }

    fn device_index(&self) -> u32 {
        self.device_index
    }

    fn shutdown_token(&self) -> CancellationToken {
        self.shutdown.clone()
    }

    fn push_server_handle(&mut self, handle: JoinHandle<()>) {
        self.server_handles.push(handle);
    }

    fn mark_connected(&mut self, connection_id: Uuid) {
        self.connected = Some(ConnectedDevice {
            index: self.device_index(),
            connection_id,
        });
    }

    fn take_lease(&mut self) -> Option<pool::DeviceLease> {
        self.lease.take()
    }

    fn restore_lease(&mut self, lease: pool::DeviceLease) {
        self.lease = Some(lease);
    }

    async fn abort_servers(&mut self) {
        self.shutdown.cancel();
        abort_server_handles(std::mem::take(&mut self.server_handles)).await;
    }

    async fn release_clean(mut self) {
        self.abort_servers().await;
        if let Some(lease) = self.lease.take() {
            self.pool.release_clean(lease).await;
        }
    }

    async fn discard(mut self) {
        self.abort_servers().await;
        if let Some(lease) = self.lease.take() {
            self.pool.discard(lease).await;
        }
    }

    async fn retire_uncertain(mut self) {
        self.abort_servers().await;
        if let Some(lease) = self.lease.take() {
            self.pool.retire_uncertain(lease).await;
        }
    }

    async fn disconnect_owned_and_release(self) {
        self.disconnect_for_cleanup_and_release(CreateDisconnectCleanupMode::AmbiguousConnect)
            .await;
    }

    async fn disconnect_and_release(self) -> bool {
        self.disconnect_for_cleanup_and_release(CreateDisconnectCleanupMode::SizeRetry)
            .await
    }

    async fn disconnect_for_cleanup_and_release(
        mut self,
        mode: CreateDisconnectCleanupMode,
    ) -> bool {
        self.abort_servers().await;
        let status = match self.connected.take() {
            Some(connected) => self.disconnect_current_for_cleanup(mode, connected).await,
            None => CreateDisconnectStatus::Uncertain,
        };
        if let Some(lease) = self.lease.take() {
            if status.is_clean() {
                self.pool.release_clean(lease).await;
            } else {
                self.pool.retire_uncertain(lease).await;
            }
        }
        status.is_clean()
    }

    async fn disconnect_current_for_cleanup(
        &mut self,
        mode: CreateDisconnectCleanupMode,
        connected: ConnectedDevice,
    ) -> CreateDisconnectStatus {
        self.disconnect_owned_for_cleanup(mode, connected).await
    }

    async fn disconnect_owned_for_cleanup(
        &mut self,
        mode: CreateDisconnectCleanupMode,
        connected: ConnectedDevice,
    ) -> CreateDisconnectStatus {
        match self.take_lease() {
            Some(lease) => {
                match disconnect_connected_if_owned_result_with_lease_and_kernel(
                    connected,
                    self.pool.clone(),
                    lease,
                    self.kernel.clone(),
                )
                .await
                {
                    Ok(outcome) => match outcome.into_parts() {
                        Ok((lease, disconnect_result)) => {
                            self.restore_lease(lease);
                            self.owned_disconnect_status(mode, connected, disconnect_result)
                        }
                        Err(e) => {
                            log_owned_disconnect_result_failed(mode, connected, &e);
                            CreateDisconnectStatus::Uncertain
                        }
                    },
                    Err(e) => {
                        log_owned_disconnect_task_failed(mode, connected, &e);
                        CreateDisconnectStatus::Uncertain
                    }
                }
            }
            None => match disconnect_connected_if_owned_result_with_kernel(
                connected,
                self.kernel.clone(),
            )
            .await
            {
                Ok(disconnect_state) => {
                    self.owned_disconnect_status(mode, connected, Ok(disconnect_state))
                }
                Err(e) => {
                    log_owned_disconnect_failed(mode, connected, &e);
                    CreateDisconnectStatus::Uncertain
                }
            },
        }
    }

    fn owned_disconnect_status(
        &self,
        mode: CreateDisconnectCleanupMode,
        connected: ConnectedDevice,
        disconnect_result: Result<OwnedDisconnectState>,
    ) -> CreateDisconnectStatus {
        let status = CreateDisconnectStatus::from_owned_result(&disconnect_result);
        match disconnect_result {
            Ok(OwnedDisconnectState::Disconnected) => {}
            Ok(OwnedDisconnectState::Foreign) => {
                log_owned_disconnect_foreign(mode, connected);
            }
            Err(e) => {
                log_owned_disconnect_failed(mode, connected, &e);
            }
        }
        status
    }

    fn into_device(
        mut self,
        cow_file: &Path,
        cow: cow_io::CowIo,
    ) -> Result<(NbdCowDevice, pool::DeviceLease)> {
        let Some(connected) = self.connected else {
            return Err(error::NbdCowError::Io(std::io::Error::other(
                "connected device missing during NBD COW create",
            )));
        };
        let Some(lease) = self.lease.take() else {
            return Err(error::NbdCowError::Io(std::io::Error::other(
                "pool lease missing during NBD COW create",
            )));
        };
        self.connected = None;
        let shutdown = std::mem::replace(&mut self.shutdown, CancellationToken::new());
        let server_handles = std::mem::take(&mut self.server_handles);

        Ok((
            NbdCowDevice {
                device_index: connected.index,
                device_path: PathBuf::from(format!("/dev/nbd{}", connected.index)),
                cow_file: cow_file.to_path_buf(),
                cow,
                server_handles,
                shutdown,
                disconnected: false,
                connection_id: connected.connection_id,
            },
            lease,
        ))
    }
}

fn log_owned_disconnect_result_failed(
    mode: CreateDisconnectCleanupMode,
    connected: ConnectedDevice,
    error: &error::NbdCowError,
) {
    match mode {
        CreateDisconnectCleanupMode::AmbiguousConnect => {
            tracing::warn!(
                device_index = connected.index,
                error = %error,
                "owned NBD disconnect result failed during create cleanup"
            );
        }
        CreateDisconnectCleanupMode::SizeRetry => {
            tracing::warn!(
                device_index = connected.index,
                error = %error,
                "owned NBD disconnect result failed during create retry cleanup"
            );
        }
    }
}

fn log_owned_disconnect_task_failed(
    mode: CreateDisconnectCleanupMode,
    connected: ConnectedDevice,
    error: &error::NbdCowError,
) {
    match mode {
        CreateDisconnectCleanupMode::AmbiguousConnect => {
            tracing::warn!(
                device_index = connected.index,
                error = %error,
                "owned NBD disconnect task failed during create cleanup"
            );
        }
        CreateDisconnectCleanupMode::SizeRetry => {
            tracing::warn!(
                device_index = connected.index,
                error = %error,
                "owned NBD disconnect task failed during create retry cleanup"
            );
        }
    }
}

fn log_owned_disconnect_failed(
    mode: CreateDisconnectCleanupMode,
    connected: ConnectedDevice,
    error: &error::NbdCowError,
) {
    match mode {
        CreateDisconnectCleanupMode::AmbiguousConnect => {
            tracing::warn!(
                device_index = connected.index,
                error = %error,
                "owned NBD disconnect failed during create cleanup"
            );
        }
        CreateDisconnectCleanupMode::SizeRetry => {
            tracing::warn!(
                device_index = connected.index,
                error = %error,
                "owned NBD disconnect failed during create retry cleanup"
            );
        }
    }
}

fn log_owned_disconnect_foreign(mode: CreateDisconnectCleanupMode, connected: ConnectedDevice) {
    match mode {
        CreateDisconnectCleanupMode::AmbiguousConnect => {
            tracing::warn!(
                device_index = connected.index,
                "skipping create cleanup disconnect: device belongs to a different connection"
            );
        }
        CreateDisconnectCleanupMode::SizeRetry => {
            tracing::warn!(
                device_index = connected.index,
                "skipping create retry cleanup disconnect: device belongs to a different connection"
            );
        }
    }
}

impl<K: CreateKernel> Drop for CreateAttemptGuard<K> {
    fn drop(&mut self) {
        self.shutdown.cancel();
        for handle in self.server_handles.drain(..) {
            handle.abort();
        }
        if let Some(connected) = self.connected.take() {
            DeferredCreateCleanup::new(connected, self.pool.clone(), self.lease.take())
                .dispatch(&self.runtime, self.kernel.clone());
        }
        if let Some(lease) = self.lease.take() {
            let device_index = lease.index();
            tracing::warn!(
                device_index,
                "NBD COW create attempt dropped before completion; retiring pool lease as uncertain"
            );
            self.pool.retire_uncertain_detached(lease);
        }
    }
}

impl NbdCowDevice {
    /// Create a new NBD COW device.
    ///
    /// 1. Acquires a host-locked device claim from the pool
    /// 2. Creates socketpairs (NUM_CONNECTIONS connections)
    /// 3. Spawns dispatch tasks for each connection
    /// 4. Connects via netlink to the specific device
    ///
    /// Two retry loops:
    /// - **Inner (EBUSY):** If the kernel reports the claimed device is busy
    ///   (for example, a non-cooperating owner or stale sysfs observation), try a
    ///   different device. This has its own budget (up to 16 retries) separate
    ///   from the size-verification loop.
    /// - **Outer (size-stuck-at-0):** If the kernel hasn't finished tearing down
    ///   a previous connection, disconnect, release with cooldown, and retry
    ///   with fresh sockets. Up to 5 retries with 200ms sleep between attempts.
    pub(super) async fn create_inner(
        base_image: &Path,
        cow_file: &Path,
        size: u64,
        device_pool: &pool::DevicePoolHandle,
        observer: Option<&mut dyn NbdCowCreateObserver>,
    ) -> Result<(Self, pool::DeviceLease)> {
        Self::create_with_kernel(
            base_image,
            cow_file,
            size,
            device_pool,
            observer,
            NativeKernel,
        )
        .await
    }

    async fn create_with_kernel(
        base_image: &Path,
        cow_file: &Path,
        size: u64,
        device_pool: &pool::DevicePoolHandle,
        observer: Option<&mut dyn NbdCowCreateObserver>,
        kernel: impl CreateKernel,
    ) -> Result<(Self, pool::DeviceLease)> {
        let mut timing = NbdCowCreateTiming::new(observer);
        let result = async {
            let cow_started_at = Instant::now();
            let cow_layer = cow::CowLayer::new(
                base_image,
                cow_file,
                size,
                BLOCK_SIZE,
                DEFAULT_FLUSH_THRESHOLD,
            );
            timing.record_stage(
                NbdCowCreateStage::CowLayerCreate,
                cow_started_at,
                cow_layer.is_ok(),
            );
            let cow = cow_io::CowIo::new(cow_layer?);
            let mut context =
                CreateContext::new(device_pool, cow_file, cow, size, &mut timing, kernel);

            context.create_with_size_retries().await
        }
        .await;
        timing.finish(result.is_ok());
        result
    }
}

#[cfg(test)]
mod cancellation_tests;
#[cfg(test)]
mod size_retry_tests;

async fn abort_server_handles(handles: Vec<JoinHandle<()>>) {
    for handle in &handles {
        handle.abort();
    }
    for handle in handles {
        let _ = handle.await;
    }
}

#[cfg(test)]
mod tests {
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

        let unknown: Result<OwnedDisconnectState> = Err(error::NbdCowError::Io(
            std::io::Error::other("ownership unknown"),
        ));
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
}
