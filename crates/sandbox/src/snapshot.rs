use std::path::{Path, PathBuf};

use async_trait::async_trait;

/// Configuration for creating a snapshot.
#[derive(Debug)]
pub struct SnapshotCreateConfig {
    /// Unique identifier for this snapshot.
    ///
    /// The format is provider-specific. The Firecracker provider uses this
    /// value as its runtime socket directory name and requires a single,
    /// non-empty normal ASCII path segment containing only letters, digits,
    /// `.`, `-`, and `_`. The special `.` and `..` components, nested or
    /// composite values such as `<rootfs>/<snapshot>`, are invalid.
    ///
    /// The complete guest-control listener path
    /// `/run/vm0/sock/<id>/vsock/vsock.sock_52000` must be at most 107 bytes,
    /// the usable Linux Unix socket pathname limit. The current guest-control
    /// port is 52000, so its `_52000` suffix reserves six bytes: the unsuffixed
    /// `vsock.sock` path must be at most 101 bytes. With the default socket root
    /// `/run/vm0/sock/`, this leaves at most 70 ASCII bytes for the ID.
    ///
    /// | ID length (ASCII bytes) | Base path (bytes) | Listener path (bytes) | Fits listener limit? |
    /// | --- | --- | --- | --- |
    /// | 70 | 101 | 107 | Yes |
    /// | 71 | 102 | 108 | No |
    ///
    /// Firecracker's early validation reserves the longer of the Guest control
    /// and Guest-to-Runner RPC listener suffixes. Invalid ID syntax or a
    /// port-suffixed listener path longer than 107 bytes is rejected as
    /// [`SnapshotError::Setup`] before checking prerequisites or cleaning
    /// snapshot output. Under the default root, a 71-byte ID fails this check.
    /// Other providers may impose different requirements; this provider-specific
    /// contract is not enforced by the provider-neutral configuration type.
    pub id: String,
    /// Path to the sandbox backend binary (e.g., firecracker).
    pub binary_path: PathBuf,
    /// Path to the guest kernel image.
    pub kernel_path: PathBuf,
    /// Path to the root filesystem image.
    pub rootfs_path: PathBuf,
    /// Directory where snapshot artifacts will be written.
    pub output_dir: PathBuf,
    /// Number of vCPUs for the VM.
    pub vcpu_count: u32,
    /// Memory size in MiB for the VM.
    pub memory_mb: u32,
    /// Workspace disk size in MiB for the temporary workspace image used by the snapshot VM.
    pub workspace_disk_mb: u32,
}

/// Output paths from a successful snapshot creation.
#[derive(Debug)]
pub struct SnapshotOutput {
    /// Path to the snapshot state file.
    pub snapshot_path: PathBuf,
    /// Path to the memory dump file.
    pub memory_path: PathBuf,
    /// Path to the COW (copy-on-write) file.
    pub cow_path: PathBuf,
}

/// Errors that can occur during snapshot operations.
///
/// These variants describe provider-neutral failure categories returned by
/// [`SnapshotProvider`] operations. A failed snapshot attempt should be treated
/// as incomplete: callers should not reuse output artifacts from the failed
/// attempt unless the concrete provider documents a stronger guarantee.
#[derive(Debug, thiserror::Error)]
pub enum SnapshotError {
    /// The provider could not prepare host resources, validate inputs, or
    /// finish provider-specific setup needed before the snapshot can complete.
    ///
    /// Retry is usually only useful after fixing the reported prerequisite,
    /// configuration, or transient resource-allocation failure.
    #[error("setup failed: {0}")]
    Setup(String),
    /// The sandbox backend process or its launch chain failed while creating
    /// the snapshot.
    ///
    /// This includes failures to spawn the backend and cases where the backend
    /// exits before the provider can complete the snapshot workflow.
    #[error("process failed: {0}")]
    Process(String),
    /// The provider failed while releasing or finalizing snapshot resources.
    ///
    /// The output should be treated as invalid. Retry may require operator
    /// cleanup or the provider's garbage-collection path, depending on the
    /// concrete backend.
    #[error("teardown failed: {0}")]
    Teardown(String),
    /// The backend API reported an error while configuring, starting, pausing,
    /// or snapshotting the sandbox.
    ///
    /// Retry depends on whether the API failure was caused by transient backend
    /// state or by an invalid snapshot configuration.
    #[error("backend api error: {0}")]
    Api(String),
    /// The provider could not establish or observe the guest readiness
    /// connection required for snapshot creation.
    ///
    /// The backend may have started, but the snapshot workflow did not reach a
    /// complete state.
    #[error("vsock connection failed: {0}")]
    Vsock(String),
    /// A host I/O operation failed while preparing, finalizing, or checking
    /// snapshot artifacts.
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
}

/// Pending provider-side publish step for a created snapshot.
///
/// A pending publish means the provider finished all live runtime work needed
/// to create the snapshot, but has not yet made the output reusable. Call
/// [`commit`](Self::commit) to publish the provider-specific completion marker
/// and return the output paths, or [`discard`](Self::discard) to abandon the
/// uncommitted artifacts. Dropping this object without an explicit call must
/// not publish a usable snapshot.
///
/// `discard` is the deterministic cleanup path. Callers that coordinate access
/// to the output directory should call it before releasing that exclusivity.
/// Implementations may intentionally keep `Drop` narrower than `discard` so a
/// late drop cannot remove a snapshot published by a later owner of the same
/// output directory.
///
/// `commit` takes `&mut self` so a failed publish can preserve provider-owned
/// cleanup state. Callers may then call `discard` best-effort before treating
/// the output as incomplete.
#[async_trait]
pub trait PendingSnapshotPublish: Send {
    /// Make the snapshot reusable and return the stable output paths.
    async fn commit(&mut self) -> Result<SnapshotOutput, SnapshotError>;

    /// Abandon the uncommitted snapshot artifacts.
    ///
    /// This should be called while the caller still owns any output-directory
    /// lock or equivalent coordination needed by the provider.
    async fn discard(&mut self) -> Result<(), SnapshotError>;
}

/// Creates snapshots for fast sandbox boot.
///
/// This is a lightweight, stateless trait — it does not require a
/// [`SandboxRuntime`](crate::SandboxRuntime) instance.
#[async_trait]
pub trait SnapshotProvider: Send + Sync {
    /// Create a snapshot and return a pending provider-side publish step.
    ///
    /// The pending object represents the boundary after provider runtime
    /// resources have been cleaned up and before the snapshot is made reusable.
    async fn create_uncommitted_snapshot(
        &self,
        config: SnapshotCreateConfig,
    ) -> Result<Box<dyn PendingSnapshotPublish>, SnapshotError>;

    /// Create a snapshot by booting a temporary VM, configuring it, and
    /// capturing its state to the output directory.
    ///
    /// The default implementation calls
    /// [`create_uncommitted_snapshot`](Self::create_uncommitted_snapshot),
    /// then commits the returned [`PendingSnapshotPublish`]. It returns the
    /// stable output paths only after the pending publish commits successfully.
    ///
    /// If the pending publish commit fails, the default implementation calls
    /// [`PendingSnapshotPublish::discard`] best-effort and returns the original
    /// commit error. Any discard error is intentionally suppressed, and callers
    /// should treat the attempted output as incomplete.
    ///
    /// Providers that override this method should preserve the same
    /// cleanup/error semantics or explicitly document a stronger
    /// provider-specific guarantee.
    async fn create_snapshot(
        &self,
        config: SnapshotCreateConfig,
    ) -> Result<SnapshotOutput, SnapshotError> {
        let mut pending = self.create_uncommitted_snapshot(config).await?;
        match pending.commit().await {
            Ok(output) => Ok(output),
            Err(err) => {
                let _ = pending.discard().await;
                Err(err)
            }
        }
    }

    /// Content hash of all internal configuration that affects snapshot output.
    ///
    /// Used by the runner to build a composite cache key for snapshots.
    fn config_hash(&self) -> String;

    /// Check whether the output directory contains a complete provider-specific snapshot.
    async fn is_complete(&self, output_dir: &Path) -> Result<bool, SnapshotError>;
}
