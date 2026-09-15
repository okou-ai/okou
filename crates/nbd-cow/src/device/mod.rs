use std::path::{Path, PathBuf};

use crate::error::Result;
use crate::{cow, cow_io, error, netlink};
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

mod connection;
mod create;
mod create_timing;
mod finalizer;
mod kernel;
mod pooled;

pub use connection::is_our_thread;
pub(crate) use create_timing::NbdNetlinkConnectTiming;
pub use create_timing::{
    NbdCowCreateObserver, NbdCowCreateOutcome, NbdCowCreateStage, NbdNetlinkConnectStage,
};
pub use pooled::{DestroyRetryPolicy, KeptCow, PooledDestroyError, PooledNbdCowDevice};

use connection::{
    ConnectedDevice, DeviceOwnership, OwnedDisconnectState, device_ownership,
    disconnect_connected_if_owned_result_critical_section,
};

/// An NBD COW block device backed by a base image and sparse COW file.
///
/// The device appears as `/dev/nbdN` and can be used as a Firecracker rootfs.
/// Writes go to an in-memory buffer and are flushed to the sparse COW file
/// when buffered data reaches [`crate::DEFAULT_FLUSH_THRESHOLD`]. NBD FLUSH
/// requests and orderly disconnect or shutdown also flush pending writes and
/// fsync the COW file. Idle time alone does not flush sub-threshold writes;
/// there is no periodic flush timer.
/// Reads check the buffer, then COW file, then base image.
///
/// Threshold-triggered flushing does not fsync the COW file or persist the dirty
/// bitmap. Use [`Self::destroy_keep_cow`] to preserve the COW file and bitmap for
/// snapshots. Dropping the device only performs best-effort cleanup and may
/// discard buffered writes.
pub struct NbdCowDevice {
    /// NBD device index (N in /dev/nbdN).
    device_index: u32,
    /// Path to the block device (e.g., /dev/nbd0).
    device_path: PathBuf,
    /// Path to the sparse COW file.
    cow_file: PathBuf,
    /// Shared COW I/O boundary (also held by dispatch tasks).
    cow: cow_io::CowIo,
    /// Background server task handles (one per connection).
    server_handles: Vec<JoinHandle<()>>,
    /// Shutdown signal for all server tasks.
    shutdown: CancellationToken,
    /// Set to true after shutdown_inner completes, so Drop doesn't double-disconnect.
    disconnected: bool,
    /// Unique identity recorded by the kernel in `/sys/block/nbdN/backend`.
    connection_id: Uuid,
}

impl NbdCowDevice {
    /// NBD device index (N in `/dev/nbdN`).
    pub fn device_index(&self) -> u32 {
        self.device_index
    }

    /// Path to the block device (e.g., `/dev/nbd0`).
    pub fn device_path(&self) -> &Path {
        &self.device_path
    }

    /// Path to the sparse COW file.
    pub fn cow_file(&self) -> &Path {
        &self.cow_file
    }

    fn relocate_cow_file_after_rename(&mut self, cow_file: PathBuf) -> Result<()> {
        self.cow.relocate_cow_file_after_rename(cow_file.clone())?;
        self.cow_file = cow_file;
        Ok(())
    }

    /// Log COW device status for debugging.
    pub async fn log_status(&self) {
        match self.cow.status().await {
            Ok(status) => {
                tracing::info!(
                    device_index = self.device_index,
                    device_path = %self.device_path.display(),
                    dirty_blocks = status.dirty_blocks,
                    buffered_blocks = status.buffered_blocks,
                    buffer_bytes = status.buffer_bytes,
                    "NBD COW device status"
                );
            }
            Err(e) => {
                tracing::warn!(
                    device_index = self.device_index,
                    device_path = %self.device_path.display(),
                    "failed to read NBD COW device status: {e}"
                );
            }
        }
    }

    /// Mark the device as abandoned without disconnecting the kernel device.
    ///
    /// Use as a last resort when netlink disconnect fails. Cancels tasks
    /// and marks the device as disconnected so Drop becomes a no-op. The
    /// kernel device may remain connected after this method returns. `runner
    /// gc` considers it eligible only after the connecting TID recorded in
    /// `/sys/block/nbdN/pid` no longer exists; it skips the device while that
    /// TID is still alive. The kernel may also disconnect an orphan with
    /// pending I/O after its configured dead-connection timeout.
    pub fn abandon(&mut self) {
        tracing::warn!(
            device_index = self.device_index,
            "NBD device abandoned — requires `runner gc` for cleanup"
        );
        self.shutdown.cancel();
        for handle in self.server_handles.drain(..) {
            handle.abort();
        }
        self.disconnected = true;
    }

    /// Destroy the device, removing the COW file and bitmap.
    pub async fn destroy(&mut self) -> Result<()> {
        self.shutdown_inner(false).await?;
        remove_cow_files(&self.cow_file)
    }

    /// Destroy the device but keep the COW file for snapshot persistence.
    ///
    /// Saves the dirty bitmap as a sidecar file (`{cow_file}.bitmap`). To
    /// restore the device, keep the COW file and sidecar paired, then call
    /// [`DevicePoolHandle::create_cow_device`](crate::pool::DevicePoolHandle::create_cow_device)
    /// with a base image containing the original unchanged-block contents, the
    /// preserved COW path, and the original device size.
    pub async fn destroy_keep_cow(&mut self) -> Result<()> {
        self.shutdown_inner(true).await
    }

    async fn shutdown_inner(&mut self, save_bitmap: bool) -> Result<()> {
        self.prepare_shutdown(save_bitmap).await?;
        self.disconnect_for_shutdown().await?;
        self.wait_for_kernel_release().await;
        Ok(())
    }

    async fn prepare_shutdown(&mut self, save_bitmap: bool) -> Result<()> {
        // Signal all dispatch tasks to stop
        self.shutdown.cancel();

        // Wait for all tasks to complete (they will flush on shutdown)
        for handle in self.server_handles.drain(..) {
            let _ = handle.await;
        }

        // Tasks are stopped — we have exclusive logical access to the COW layer.
        // Save bitmap before disconnecting if keeping the COW file.
        if save_bitmap {
            self.cow.save_bitmap(self.bitmap_path()).await?;
        }

        Ok(())
    }

    async fn disconnect_for_shutdown(&mut self) -> Result<()> {
        // Disconnect via netlink, only if we still own the device. On shared
        // hosts, another runner may have already disconnected our device and
        // recycled the index; blindly calling disconnect(device_index) would
        // tear down the new owner's device. Keep the ownership check inside the
        // blocking critical section so queueing cannot widen that race window.
        if !self.disconnected {
            let connected = ConnectedDevice {
                index: self.device_index,
                connection_id: self.connection_id,
            };
            let state = disconnect_connected_if_owned_result_critical_section(connected).await?;
            self.apply_owned_disconnect_state(state);
        }

        Ok(())
    }

    fn apply_owned_disconnect_state(&mut self, state: OwnedDisconnectState) {
        match state {
            OwnedDisconnectState::Disconnected => {
                self.disconnected = true;
            }
            OwnedDisconnectState::Foreign => {
                self.disconnected = true;
                tracing::warn!(
                    device_index = self.device_index,
                    "skipping disconnect: device belongs to a different connection"
                );
            }
        }
    }

    async fn wait_for_kernel_release(&self) {
        // Wait for kernel to release the device (poll pid file)
        let pid_path = format!("/sys/block/nbd{}/pid", self.device_index);
        for _ in 0..10 {
            match std::fs::read_to_string(&pid_path) {
                Ok(content) => {
                    let pid = content.trim();
                    if pid == "-1" || pid == "0" || pid.is_empty() {
                        break;
                    }
                }
                Err(_) => break, // pid file gone means device released
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
    }

    /// Check if we still own the NBD device by comparing the sysfs backend
    /// identifier against the UUID recorded at connect time.
    fn device_ownership(&self) -> DeviceOwnership {
        device_ownership(self.device_index, self.connection_id)
    }

    fn bitmap_path(&self) -> PathBuf {
        cow::bitmap_path_for(&self.cow_file)
    }
}

pub(super) fn remove_cow_files(cow_file: &Path) -> Result<()> {
    remove_file_if_exists(cow_file)?;
    remove_file_if_exists(&cow::bitmap_path_for(cow_file))?;
    Ok(())
}

fn remove_file_if_exists(path: &Path) -> Result<()> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(error::NbdCowError::Io(std::io::Error::new(
            e.kind(),
            format!("failed to remove {}: {e}", path.display()),
        ))),
    }
}

/// Best-effort cleanup on drop: cancel tasks and disconnect the NBD device.
/// This ensures leaked devices are cleaned up even if `destroy()` is not called
/// (e.g., test panics).
///
/// **Note:** Drop aborts dispatch tasks immediately without waiting for them to
/// flush buffered writes. Any data in the write buffer that has not been flushed
/// is silently lost. Always call [`destroy()`](Self::destroy) or
/// [`destroy_keep_cow()`](Self::destroy_keep_cow) for clean shutdown with data
/// persistence guarantees.
impl Drop for NbdCowDevice {
    fn drop(&mut self) {
        self.shutdown.cancel();
        // Abort all server tasks (they may be blocked on socket I/O)
        for handle in self.server_handles.drain(..) {
            handle.abort();
        }
        // Only disconnect if shutdown_inner hasn't already done it AND we
        // still own the device. Another runner's cleanup may have already
        // disconnected our index and a third runner may have recycled it.
        if !self.disconnected
            && matches!(self.device_ownership(), DeviceOwnership::Ours)
            && let Err(e) = netlink::disconnect(self.device_index)
        {
            tracing::warn!(
                device_index = self.device_index,
                error = %e,
                "NBD disconnect failed during drop"
            );
        }
    }
}
