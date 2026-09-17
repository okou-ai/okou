use std::path::{Path, PathBuf};
use std::time::Duration;

use crate::error::{self, Result};
use crate::pool;

use super::connection::{
    ConnectedDevice, disconnect_connected_if_owned_result_with_lease_critical_section,
};
use super::finalizer::{PooledCowFinalizer, run_finalizer};
use super::{NbdCowDevice, remove_cow_files};

/// Retry policy for the shutdown phase of pooled COW finalization.
///
/// A shutdown attempt includes pre-disconnect finalization such as dirty
/// bitmap persistence for keep-COW finalization. After shutdown succeeds,
/// [`PooledNbdCowDevice::destroy_with_retries`] attempts to remove the COW file
/// and bitmap once; that storage cleanup is not retried.
#[derive(Clone, Copy, Debug)]
pub struct DestroyRetryPolicy {
    /// Number of shutdown attempts. Values below 1 are treated as 1 attempt.
    pub attempts: u32,
    /// Delay between failed shutdown attempts.
    pub delay: Duration,
}

impl DestroyRetryPolicy {
    fn attempts(self) -> u32 {
        self.attempts.max(1)
    }
}

/// Paths produced by a successful keep-COW finalizer.
#[derive(Debug)]
pub struct KeptCow {
    /// Preserved COW file path.
    pub cow_file: PathBuf,
    /// Persisted dirty bitmap sidecar path.
    pub bitmap_file: PathBuf,
}

/// Error returned by detailed pooled COW destroy finalizers.
#[derive(Debug)]
pub struct PooledDestroyError {
    source: error::NbdCowError,
    backing_files_safe_to_delete: bool,
}

impl PooledDestroyError {
    fn device_cleanup(source: error::NbdCowError) -> Self {
        Self {
            source,
            backing_files_safe_to_delete: false,
        }
    }

    fn storage_cleanup(source: error::NbdCowError) -> Self {
        Self {
            source,
            backing_files_safe_to_delete: true,
        }
    }

    /// Whether the NBD device has been disconnected and backing files are no
    /// longer referenced by this pooled device.
    pub fn backing_files_safe_to_delete(&self) -> bool {
        self.backing_files_safe_to_delete
    }

    /// Consume this detailed error and return the underlying `nbd-cow` error.
    pub fn into_inner(self) -> error::NbdCowError {
        self.source
    }
}

impl std::fmt::Display for PooledDestroyError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.source.fmt(f)
    }
}

impl std::error::Error for PooledDestroyError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(&self.source)
    }
}

impl From<error::NbdCowError> for PooledDestroyError {
    fn from(source: error::NbdCowError) -> Self {
        Self::device_cleanup(source)
    }
}

impl pool::DevicePoolHandle {
    /// Create a pooled NBD COW device.
    ///
    /// `base_image` is the read-only image used for reads from unchanged
    /// blocks, `cow_file` is the sparse copy-on-write file used for dirty
    /// blocks, and `size` is the block-device size exposed through the NBD
    /// device.
    ///
    /// On success, the returned [`PooledNbdCowDevice`] owns a pool lease for a
    /// `/dev/nbdN` device claimed through the cooperative pool. Callers must
    /// finish the lifecycle with an explicit finalizer such as
    /// [`PooledNbdCowDevice::destroy_with_retries`],
    /// [`PooledNbdCowDevice::destroy_keep_cow_with_retries`], or
    /// [`PooledNbdCowDevice::abandon`].
    ///
    /// This method must be awaited from a Tokio runtime. Device setup starts
    /// async dispatch tasks and uses async pool and netlink paths.
    ///
    /// If creation fails after partial setup, started dispatch tasks are stopped
    /// and any checked-out pool lease is returned only when the device state is
    /// known clean; otherwise the lease is discarded or retired as uncertain.
    pub async fn create_cow_device(
        &self,
        base_image: &Path,
        cow_file: &Path,
        size: u64,
    ) -> Result<PooledNbdCowDevice> {
        let (device, lease) =
            NbdCowDevice::create_inner(base_image, cow_file, size, self, None).await?;
        Ok(PooledNbdCowDevice {
            device,
            lease: LeaseGuard::new(lease, self.clone()),
            pool: self.clone(),
        })
    }

    /// Create a pooled NBD COW device and report aggregate creation stages.
    ///
    /// The observer receives fixed, low-cardinality records after creation
    /// returns success or an ordinary error. Cancellation preserves the same
    /// cleanup behavior as [`Self::create_cow_device`] and does not invoke the
    /// observer from `Drop`.
    pub async fn create_cow_device_with_observer(
        &self,
        base_image: &Path,
        cow_file: &Path,
        size: u64,
        observer: &mut dyn super::NbdCowCreateObserver,
    ) -> Result<PooledNbdCowDevice> {
        let (device, lease) =
            NbdCowDevice::create_inner(base_image, cow_file, size, self, Some(observer)).await?;
        Ok(PooledNbdCowDevice {
            device,
            lease: LeaseGuard::new(lease, self.clone()),
            pool: self.clone(),
        })
    }
}

#[derive(Clone, Copy)]
enum DestroyMode {
    RemoveCow,
    KeepCow,
}

enum DestroyAttemptError {
    Device(error::NbdCowError),
    Storage(error::NbdCowError),
}

/// A COW device that owns a pooled host `/dev/nbdN` lease.
///
/// This value is the lifecycle owner for both the connected COW device and the
/// pool lease. Finish every successful creation with one explicit terminal
/// path:
///
/// - [`destroy_with_retries`](Self::destroy_with_retries) for normal cleanup
///   that removes the COW file and bitmap.
/// - [`destroy_keep_cow_with_retries`](Self::destroy_keep_cow_with_retries) to
///   preserve the COW file and bitmap for snapshot persistence.
/// - [`abandon`](Self::abandon) when cleanup cannot be completed reliably and
///   the pool should treat the lease as uncertain.
///
/// Dropping this value is only an emergency best-effort fallback. It may discard
/// unflushed COW writes and retires the pool lease as uncertain instead of
/// releasing it cleanly.
#[must_use = "pooled NBD COW devices own a /dev/nbdN lease; call an explicit finalizer"]
pub struct PooledNbdCowDevice {
    device: NbdCowDevice,
    lease: LeaseGuard,
    pool: pool::DevicePoolHandle,
}

pub(super) struct LeaseGuard {
    lease: Option<pool::DeviceLease>,
    pool: pool::DevicePoolHandle,
}

impl LeaseGuard {
    pub(super) fn new(lease: pool::DeviceLease, pool: pool::DevicePoolHandle) -> Self {
        Self {
            lease: Some(lease),
            pool,
        }
    }

    fn take(&mut self) -> Option<pool::DeviceLease> {
        self.lease.take()
    }

    fn restore(&mut self, lease: pool::DeviceLease) {
        debug_assert!(self.lease.is_none(), "restoring duplicate pool lease");
        self.lease = Some(lease);
    }
}

impl Drop for LeaseGuard {
    fn drop(&mut self) {
        if let Some(lease) = self.lease.take() {
            let device_index = lease.index();
            tracing::warn!(
                device_index,
                "pooled NBD COW device dropped without finalizer; retiring pool lease as uncertain"
            );
            self.pool.retire_uncertain_detached(lease);
        }
    }
}

impl PooledNbdCowDevice {
    /// NBD device index (N in `/dev/nbdN`), for diagnostics only.
    pub fn device_index(&self) -> u32 {
        self.device.device_index()
    }

    /// Path to the block device (e.g., `/dev/nbd0`).
    pub fn device_path(&self) -> &Path {
        self.device.device_path()
    }

    /// Path to the sparse COW file.
    pub fn cow_file(&self) -> &Path {
        self.device.cow_file()
    }

    /// Update the recorded COW path after its backing file has been renamed.
    ///
    /// The caller must move the same backing file within one filesystem before
    /// calling this method. This updates only path metadata used by bitmap
    /// persistence and cleanup; it does not reopen, reset, or rebind the COW
    /// layer or NBD device. Relocation waits for a COW operation that already
    /// holds the `CowLayer` mutex to complete before the path metadata is
    /// updated. A submitted COW operation that has not yet acquired the mutex
    /// is not waited on and may run after relocation returns.
    ///
    /// # Errors
    ///
    /// Returns an error if the COW layer mutex was poisoned.
    pub fn relocate_cow_file_after_rename(&mut self, cow_file: PathBuf) -> Result<()> {
        self.device.relocate_cow_file_after_rename(cow_file)
    }

    /// Log COW device status for debugging.
    pub async fn log_status(&self) {
        self.device.log_status().await;
    }

    /// Destroy the device, removing the COW file and bitmap.
    ///
    /// The policy retries the shutdown phase. After shutdown succeeds, removal
    /// of the COW file and bitmap is attempted once. A removal failure returns
    /// immediately without waiting for the configured retry delay.
    ///
    /// Finalization starts immediately. Dropping the returned future does not
    /// cancel cleanup; it continues in the background and logs its result.
    /// Must be called from a Tokio runtime.
    pub fn destroy_with_retries(
        self,
        policy: DestroyRetryPolicy,
    ) -> impl std::future::Future<Output = Result<()>> + Send + 'static {
        let finalizer = self.destroy_with_retries_detailed(policy);
        async move { finalizer.await.map_err(PooledDestroyError::into_inner) }
    }

    /// Destroy the device and distinguish NBD shutdown failures from COW file
    /// cleanup failures.
    ///
    /// The policy retries the shutdown phase. After shutdown succeeds, removal
    /// of the COW file and bitmap is attempted once. A removal failure returns
    /// immediately without waiting for the configured retry delay.
    ///
    /// Finalization starts when this method is called, before the returned
    /// future is polled. Dropping the returned future does not cancel cleanup;
    /// it continues in the background and logs its result. Must be called from
    /// a Tokio runtime.
    ///
    /// A COW file or bitmap removal error reports
    /// [`PooledDestroyError::backing_files_safe_to_delete`] as `true` because
    /// the NBD device was released. Callers may therefore safely delete the
    /// containing workspace or snapshot attempt directory.
    pub fn destroy_with_retries_detailed(
        self,
        policy: DestroyRetryPolicy,
    ) -> impl std::future::Future<Output = std::result::Result<(), PooledDestroyError>> + Send + 'static
    {
        // Once finalization starts, let it run to completion even if the caller's
        // future is cancelled. Otherwise dropping the owned device mid-finalizer
        // can disconnect best-effort but leave the pool lease in flight.
        //
        // This must spawn before returning the Future: an `async fn` body would
        // not run if the returned future was dropped before its first poll.
        Self::run_finalizer(async move { self.destroy_with_retries_detailed_inner(policy).await })
    }

    async fn destroy_with_retries_detailed_inner(
        mut self,
        policy: DestroyRetryPolicy,
    ) -> std::result::Result<(), PooledDestroyError> {
        let pool = self.pool.clone();
        Self::destroy_with_mode(
            &mut self.device,
            &mut self.lease,
            &pool,
            policy,
            DestroyMode::RemoveCow,
        )
        .await
    }

    /// Destroy the device while preserving COW data for snapshot persistence.
    ///
    /// On success, returns [`KeptCow`] with the COW file and its dirty-bitmap
    /// sidecar. Preserve both files as a pair. To restore the same logical
    /// device, keep `KeptCow::bitmap_file` at the sidecar path derived from
    /// `KeptCow::cow_file`, then call
    /// [`DevicePoolHandle::create_cow_device`](crate::pool::DevicePoolHandle::create_cow_device)
    /// with a base image containing the original unchanged-block contents,
    /// `KeptCow::cow_file`, and the original device size.
    ///
    /// Finalization starts immediately. Dropping the returned future does not
    /// cancel cleanup; it continues in the background and logs its result.
    /// Must be called from a Tokio runtime.
    pub fn destroy_keep_cow_with_retries(
        self,
        policy: DestroyRetryPolicy,
    ) -> impl std::future::Future<Output = Result<KeptCow>> + Send + 'static {
        // See destroy_with_retries(): the COW file must either be finalized or
        // abandoned with the lease retired even if the awaiting task is dropped.
        Self::run_finalizer(async move { self.destroy_keep_cow_with_retries_inner(policy).await })
    }

    async fn destroy_keep_cow_with_retries_inner(
        mut self,
        policy: DestroyRetryPolicy,
    ) -> Result<KeptCow> {
        let pool = self.pool.clone();
        let cow_file = self.device.cow_file().to_path_buf();
        let bitmap_file = self.device.bitmap_path();
        Self::destroy_with_mode(
            &mut self.device,
            &mut self.lease,
            &pool,
            policy,
            DestroyMode::KeepCow,
        )
        .await
        .map_err(PooledDestroyError::into_inner)?;

        Ok(KeptCow {
            cow_file,
            bitmap_file,
        })
    }

    async fn destroy_with_mode(
        device: &mut NbdCowDevice,
        lease: &mut LeaseGuard,
        pool: &pool::DevicePoolHandle,
        policy: DestroyRetryPolicy,
        mode: DestroyMode,
    ) -> std::result::Result<(), PooledDestroyError> {
        let attempts = policy.attempts();

        let mut last_device_err = match Self::run_destroy_attempt(device, lease, pool, mode).await {
            Ok(()) => {
                Self::release_clean(pool, lease).await;
                return Ok(());
            }
            Err(DestroyAttemptError::Storage(source)) => {
                Self::release_clean(pool, lease).await;
                return Err(PooledDestroyError::storage_cleanup(source));
            }
            Err(DestroyAttemptError::Device(source)) => source,
        };

        for _ in 1..attempts {
            tokio::time::sleep(policy.delay).await;
            match Self::run_destroy_attempt(device, lease, pool, mode).await {
                Ok(()) => {
                    Self::release_clean(pool, lease).await;
                    return Ok(());
                }
                Err(DestroyAttemptError::Storage(source)) => {
                    Self::release_clean(pool, lease).await;
                    return Err(PooledDestroyError::storage_cleanup(source));
                }
                Err(DestroyAttemptError::Device(source)) => last_device_err = source,
            }
        }

        device.abandon();
        Self::retire_uncertain(pool, lease).await;
        Err(PooledDestroyError::device_cleanup(last_device_err))
    }

    async fn run_destroy_attempt(
        device: &mut NbdCowDevice,
        lease: &mut LeaseGuard,
        pool: &pool::DevicePoolHandle,
        mode: DestroyMode,
    ) -> std::result::Result<(), DestroyAttemptError> {
        match mode {
            DestroyMode::RemoveCow => {
                Self::shutdown_device_with_lease(device, lease, pool, false)
                    .await
                    .map_err(DestroyAttemptError::Device)?;
                remove_cow_files(&device.cow_file).map_err(DestroyAttemptError::Storage)
            }
            DestroyMode::KeepCow => Self::shutdown_device_with_lease(device, lease, pool, true)
                .await
                .map_err(DestroyAttemptError::Device),
        }
    }

    async fn shutdown_device_with_lease(
        device: &mut NbdCowDevice,
        lease: &mut LeaseGuard,
        pool: &pool::DevicePoolHandle,
        save_bitmap: bool,
    ) -> Result<()> {
        device.prepare_shutdown(save_bitmap).await?;

        if !device.disconnected {
            let connected = ConnectedDevice {
                index: device.device_index,
                connection_id: device.connection_id,
            };
            let Some(device_lease) = lease.take() else {
                return Err(error::NbdCowError::Io(std::io::Error::other(
                    "pool lease missing during pooled NBD shutdown",
                )));
            };
            let outcome = disconnect_connected_if_owned_result_with_lease_critical_section(
                connected,
                pool.clone(),
                device_lease,
            )
            .await?;
            let (device_lease, disconnect_result) = outcome.into_parts()?;
            lease.restore(device_lease);
            device.apply_owned_disconnect_state(disconnect_result?);
        }

        device.wait_for_kernel_release().await;
        Ok(())
    }

    /// Mark the device as abandoned and retire the pool lease as uncertain.
    ///
    /// The underlying [`NbdCowDevice::abandon`] leaves the kernel device
    /// connected. `runner gc` considers it eligible only after the connecting
    /// TID recorded in `/sys/block/nbdN/pid` no longer exists; it skips the
    /// device while that TID is still alive. The kernel may also disconnect an
    /// orphan with pending I/O after its configured dead-connection timeout.
    /// Retiring the pool lease does not make the connected device immediately
    /// reusable.
    ///
    /// Must be called from a Tokio runtime.
    pub fn abandon(self) -> impl std::future::Future<Output = ()> + Send + 'static {
        let finalizer = Self::run_finalizer(async move {
            self.abandon_inner().await;
            Ok::<(), error::NbdCowError>(())
        });
        async move {
            if let Err(e) = finalizer.await {
                tracing::warn!(error = %e, "pooled NBD COW abandon finalizer failed");
            }
        }
    }

    async fn abandon_inner(mut self) {
        let pool = self.pool.clone();
        self.device.abandon();
        Self::retire_uncertain(&pool, &mut self.lease).await;
    }

    pub(super) fn run_finalizer<T, E>(
        future: impl std::future::Future<Output = std::result::Result<T, E>> + Send + 'static,
    ) -> PooledCowFinalizer<T, E>
    where
        T: Send + 'static,
        E: From<error::NbdCowError> + std::fmt::Display + Send + 'static,
    {
        run_finalizer(future)
    }

    async fn release_clean(pool: &pool::DevicePoolHandle, lease: &mut LeaseGuard) {
        if let Some(lease) = lease.take() {
            pool.release_clean(lease).await;
        }
    }

    async fn retire_uncertain(pool: &pool::DevicePoolHandle, lease: &mut LeaseGuard) {
        if let Some(lease) = lease.take() {
            pool.retire_uncertain(lease).await;
        }
    }
}

#[cfg(test)]
mod tests {
    use std::path::{Path, PathBuf};
    use std::sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    };

    use crate::{BLOCK_SIZE, DEFAULT_FLUSH_THRESHOLD, cow, cow_io, pool};
    use tokio_util::sync::CancellationToken;

    use super::*;

    const TEST_DEVICE_INDEX: u32 = 1_000_000;
    const TEST_TIMEOUT: Duration = Duration::from_secs(1);
    const TEST_COW_DATA: [u8; BLOCK_SIZE] = [0x5a; BLOCK_SIZE];

    fn create_test_base_image(path: &Path) {
        let file = std::fs::File::create(path).expect("create base image");
        file.set_len(BLOCK_SIZE as u64).expect("size base image");
    }

    struct PooledDestroyHarness {
        _tmp: tempfile::TempDir,
        cow_file: PathBuf,
        bitmap_file: PathBuf,
        bitmap_tmp_path: PathBuf,
        pool: pool::DevicePoolHandle,
        device: PooledNbdCowDevice,
    }

    impl PooledDestroyHarness {
        fn new() -> Self {
            Self::with_cow_setup(|_| ()).0
        }

        fn with_cow_setup<T>(setup: impl FnOnce(&mut cow::CowLayer) -> T) -> (Self, T) {
            let tmp = tempfile::tempdir().expect("tempdir");
            let base = tmp.path().join("base.img");
            let cow_file = tmp.path().join("cow.img");
            let bitmap_file = cow::bitmap_path_for(&cow_file);
            let bitmap_tmp_path = cow::bitmap_tmp_path_for(&bitmap_file);
            let lock_dir = tmp.path().join("locks");
            std::fs::create_dir(&lock_dir).expect("create lock dir");
            create_test_base_image(&base);
            std::fs::write(&cow_file, b"cow").expect("write cow file");

            let pool = pool::DevicePoolHandle::new(pool::DevicePoolConfig::default());
            let mut cow = cow::CowLayer::new(
                &base,
                &cow_file,
                BLOCK_SIZE as u64,
                BLOCK_SIZE,
                DEFAULT_FLUSH_THRESHOLD,
            )
            .expect("create cow layer");
            let setup_result = setup(&mut cow);
            let device = PooledNbdCowDevice {
                device: NbdCowDevice {
                    device_index: TEST_DEVICE_INDEX,
                    device_path: PathBuf::from(format!("/dev/nbd{TEST_DEVICE_INDEX}")),
                    cow_file: cow_file.clone(),
                    cow: cow_io::CowIo::new(cow),
                    server_handles: Vec::new(),
                    shutdown: CancellationToken::new(),
                    disconnected: true,
                    connection_id: uuid::Uuid::nil(),
                },
                lease: LeaseGuard::new(
                    pool::DeviceLease::new_for_test(TEST_DEVICE_INDEX, &lock_dir),
                    pool.clone(),
                ),
                pool: pool.clone(),
            };

            (
                Self {
                    _tmp: tmp,
                    cow_file,
                    bitmap_file,
                    bitmap_tmp_path,
                    pool,
                    device,
                },
                setup_result,
            )
        }

        fn write_bitmap_sidecar(&self) {
            std::fs::write(&self.bitmap_file, b"bitmap").expect("write bitmap file");
        }

        fn create_blocking_bitmap_tmp_dir(&self) {
            std::fs::create_dir(&self.bitmap_tmp_path).expect("create bitmap tmp dir");
        }

        fn with_transient_bitmap_failure() -> (Self, Arc<AtomicUsize>) {
            Self::with_cow_setup(|cow| {
                cow.write(0, &TEST_COW_DATA).expect("buffer COW data");
                cow.fail_first_bitmap_rename()
            })
        }

        fn replace_cow_file_with_directory(&self) {
            std::fs::remove_file(&self.cow_file).expect("remove cow file");
            std::fs::create_dir(&self.cow_file).expect("create cow directory");
        }
    }

    fn zero_attempt_destroy_policy() -> DestroyRetryPolicy {
        DestroyRetryPolicy {
            attempts: 0,
            delay: std::time::Duration::from_secs(60),
        }
    }

    #[tokio::test]
    async fn destroy_with_retries_zero_attempts_runs_once_and_removes_files() {
        let harness = PooledDestroyHarness::new();
        harness.write_bitmap_sidecar();
        let PooledDestroyHarness {
            _tmp,
            cow_file,
            bitmap_file,
            pool,
            device,
            ..
        } = harness;

        tokio::time::timeout(
            std::time::Duration::from_secs(1),
            device.destroy_with_retries(zero_attempt_destroy_policy()),
        )
        .await
        .expect("destroy should not sleep before first attempt")
        .expect("destroy");

        assert!(!cow_file.exists());
        assert!(!bitmap_file.exists());
        pool.cleanup().await;
    }

    #[tokio::test]
    async fn destroy_with_retries_reports_cow_removal_failure() {
        let harness = PooledDestroyHarness::new();
        harness.replace_cow_file_with_directory();
        let PooledDestroyHarness {
            _tmp,
            cow_file,
            pool,
            device,
            ..
        } = harness;

        let result = tokio::time::timeout(
            std::time::Duration::from_secs(1),
            device.destroy_with_retries(zero_attempt_destroy_policy()),
        )
        .await
        .expect("destroy should not sleep before returning the first error");

        let err = result.expect_err("destroy should report cow removal failure");
        assert!(
            err.to_string().contains("failed to remove"),
            "unexpected error: {err}"
        );
        assert!(cow_file.is_dir());
        pool.cleanup().await;
    }

    #[tokio::test]
    async fn detailed_destroy_reports_storage_failure_as_safe_to_delete() {
        let harness = PooledDestroyHarness::new();
        harness.replace_cow_file_with_directory();
        let PooledDestroyHarness { pool, device, .. } = harness;

        let err = device
            .destroy_with_retries_detailed(zero_attempt_destroy_policy())
            .await
            .expect_err("destroy should report cow removal failure");

        assert!(
            err.backing_files_safe_to_delete(),
            "storage cleanup errors must not be treated as NBD ownership failures"
        );
        pool.cleanup().await;
    }

    #[tokio::test]
    async fn detailed_destroy_storage_failure_does_not_sleep_before_returning() {
        let harness = PooledDestroyHarness::new();
        harness.replace_cow_file_with_directory();
        let PooledDestroyHarness { pool, device, .. } = harness;

        let result = tokio::time::timeout(
            std::time::Duration::from_secs(1),
            device.destroy_with_retries_detailed(DestroyRetryPolicy {
                attempts: 2,
                delay: std::time::Duration::from_secs(60),
            }),
        )
        .await
        .expect("storage cleanup failures should not wait for device retry delay");

        let err = result.expect_err("destroy should report cow removal failure");
        assert!(err.backing_files_safe_to_delete());
        pool.cleanup().await;
    }

    #[tokio::test]
    async fn destroy_keep_cow_zero_attempts_returns_preserved_paths() {
        let PooledDestroyHarness {
            _tmp,
            cow_file,
            bitmap_file,
            pool,
            device,
            ..
        } = PooledDestroyHarness::new();

        let kept = tokio::time::timeout(
            std::time::Duration::from_secs(1),
            device.destroy_keep_cow_with_retries(zero_attempt_destroy_policy()),
        )
        .await
        .expect("destroy should not sleep before first attempt")
        .expect("destroy keep cow");

        assert_eq!(kept.cow_file, cow_file);
        assert_eq!(kept.bitmap_file, bitmap_file);
        assert!(kept.cow_file.exists());
        assert!(kept.bitmap_file.exists());
        pool.cleanup().await;
    }

    #[tokio::test]
    async fn relocated_cow_path_controls_keep_cow_bitmap_persistence() {
        let PooledDestroyHarness {
            _tmp,
            cow_file,
            bitmap_file,
            pool,
            mut device,
            ..
        } = PooledDestroyHarness::new();
        let relocated_cow = cow_file.with_file_name("relocated-cow.img");
        let relocated_bitmap = cow::bitmap_path_for(&relocated_cow);
        std::fs::rename(&cow_file, &relocated_cow).expect("relocate cow file");

        device
            .relocate_cow_file_after_rename(relocated_cow.clone())
            .expect("record relocated COW path");
        let kept = device
            .destroy_keep_cow_with_retries(zero_attempt_destroy_policy())
            .await
            .expect("destroy keep relocated cow");

        assert_eq!(kept.cow_file, relocated_cow);
        assert_eq!(kept.bitmap_file, relocated_bitmap);
        assert!(kept.cow_file.exists());
        assert!(kept.bitmap_file.exists());
        assert!(!cow_file.exists());
        assert!(!bitmap_file.exists());
        pool.cleanup().await;
    }

    #[tokio::test]
    async fn relocated_cow_path_controls_destroy_cleanup() {
        let PooledDestroyHarness {
            _tmp,
            cow_file,
            bitmap_file,
            pool,
            mut device,
            ..
        } = PooledDestroyHarness::new();
        let relocated_cow = cow_file.with_file_name("relocated-cow.img");
        let relocated_bitmap = cow::bitmap_path_for(&relocated_cow);
        std::fs::rename(&cow_file, &relocated_cow).expect("relocate cow file");
        std::fs::write(&relocated_bitmap, b"bitmap").expect("write relocated bitmap");

        device
            .relocate_cow_file_after_rename(relocated_cow.clone())
            .expect("record relocated COW path");
        device
            .destroy_with_retries(zero_attempt_destroy_policy())
            .await
            .expect("destroy relocated cow");

        assert!(!relocated_cow.exists());
        assert!(!relocated_bitmap.exists());
        assert!(!cow_file.exists());
        assert!(!bitmap_file.exists());
        pool.cleanup().await;
    }

    #[tokio::test]
    async fn destroy_keep_cow_zero_attempts_returns_first_error_without_retry_sleep() {
        let harness = PooledDestroyHarness::new();
        harness.create_blocking_bitmap_tmp_dir();
        let PooledDestroyHarness {
            _tmp,
            cow_file,
            bitmap_file,
            pool,
            device,
            ..
        } = harness;

        let result = tokio::time::timeout(
            std::time::Duration::from_secs(1),
            device.destroy_keep_cow_with_retries(zero_attempt_destroy_policy()),
        )
        .await
        .expect("destroy should not sleep before returning the first error");

        assert!(result.is_err());
        assert!(cow_file.exists());
        assert!(!bitmap_file.exists());
        pool.cleanup().await;
    }

    #[tokio::test]
    async fn destroy_keep_cow_exhausts_retries_and_returns_error() {
        let harness = PooledDestroyHarness::new();
        harness.create_blocking_bitmap_tmp_dir();
        let PooledDestroyHarness {
            _tmp,
            cow_file,
            bitmap_file,
            bitmap_tmp_path,
            pool,
            device,
        } = harness;

        let result = device
            .destroy_keep_cow_with_retries(DestroyRetryPolicy {
                attempts: 2,
                delay: std::time::Duration::ZERO,
            })
            .await;

        assert!(result.is_err());
        assert!(cow_file.exists());
        assert!(!bitmap_file.exists());
        assert!(bitmap_tmp_path.is_dir());
        pool.cleanup().await;
    }

    #[tokio::test]
    async fn destroy_keep_cow_retries_after_first_error_and_returns_preserved_paths() {
        let (harness, rename_attempts) = PooledDestroyHarness::with_transient_bitmap_failure();
        let PooledDestroyHarness {
            _tmp: tmp,
            cow_file,
            bitmap_file,
            bitmap_tmp_path,
            pool,
            device,
        } = harness;

        let result = tokio::time::timeout(
            TEST_TIMEOUT,
            device.destroy_keep_cow_with_retries(DestroyRetryPolicy {
                attempts: 2,
                delay: std::time::Duration::ZERO,
            }),
        )
        .await;
        tokio::time::timeout(TEST_TIMEOUT, pool.cleanup())
            .await
            .expect("pool cleanup should complete");
        let kept = result
            .expect("destroy keep cow should complete")
            .expect("destroy keep cow should retry after the first rename failure");

        assert_eq!(rename_attempts.load(Ordering::Relaxed), 2);
        assert_eq!(kept.cow_file, cow_file);
        assert_eq!(kept.bitmap_file, bitmap_file);
        assert_eq!(std::fs::read(&kept.cow_file).unwrap(), TEST_COW_DATA);
        assert!(kept.bitmap_file.exists());
        assert!(!bitmap_tmp_path.exists());

        let restored = cow::CowLayer::new(
            &tmp.path().join("base.img"),
            &kept.cow_file,
            BLOCK_SIZE as u64,
            BLOCK_SIZE,
            DEFAULT_FLUSH_THRESHOLD,
        )
        .expect("restore the preserved COW and bitmap");
        let mut restored_data = [0; BLOCK_SIZE];
        restored.read(0, &mut restored_data).unwrap();
        assert_eq!(restored_data, TEST_COW_DATA);
    }

    #[tokio::test]
    async fn destroy_keep_cow_single_attempt_returns_transient_bitmap_error() {
        let (harness, rename_attempts) = PooledDestroyHarness::with_transient_bitmap_failure();
        let PooledDestroyHarness {
            _tmp,
            cow_file,
            bitmap_file,
            bitmap_tmp_path,
            pool,
            device,
        } = harness;

        let result = tokio::time::timeout(
            TEST_TIMEOUT,
            device.destroy_keep_cow_with_retries(DestroyRetryPolicy {
                attempts: 1,
                delay: std::time::Duration::ZERO,
            }),
        )
        .await;
        tokio::time::timeout(TEST_TIMEOUT, pool.cleanup())
            .await
            .expect("pool cleanup should complete");
        let error = result
            .expect("destroy keep cow should complete")
            .expect_err("one attempt cannot recover from the injected rename failure");
        let error::NbdCowError::Io(error) = error else {
            panic!("expected the original rename I/O error, got {error:?}");
        };

        assert_eq!(error.raw_os_error(), Some(libc::EIO));
        assert_eq!(rename_attempts.load(Ordering::Relaxed), 1);
        assert_eq!(std::fs::read(&cow_file).unwrap(), TEST_COW_DATA);
        assert!(!bitmap_file.exists());
        assert!(!bitmap_tmp_path.exists());
    }
}
